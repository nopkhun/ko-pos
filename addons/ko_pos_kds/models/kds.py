# -*- coding: utf-8 -*-
import json
import logging

from odoo import api, fields, models

_logger = logging.getLogger(__name__)


ISSUE_TYPES = [
    ('out_of_stock', 'ของหมด'),
    ('delay', 'ล่าช้า'),
    ('substitute', 'ขอเปลี่ยนรายการ'),
    ('other', 'อื่น ๆ'),
]

ISSUE_LABELS = dict(ISSUE_TYPES)


def kds_channel(config_id):
    """One bus channel per POS. A kitchen screen must never be woken by another shop."""
    return 'ko_pos_kds_%s' % (int(config_id) if config_id else 0)


def _clean_note(note):
    if not note:
        return ''
    value = str(note).strip()
    if value.startswith('['):
        try:
            parsed = json.loads(value)
            return ', '.join(
                item.get('text', '') if isinstance(item, dict) else str(item)
                for item in parsed if item
            ).strip(', ')
        except (ValueError, TypeError):
            return value
    return value


class PosConfig(models.Model):
    _inherit = 'pos.config'

    ko_kds_sla_minutes = fields.Integer(
        string='เวลาเป้าหมายจอครัว (นาที)',
        default=15,
        help='เวลาที่การ์ดออเดอร์เปลี่ยนเป็นสถานะเกินเวลา',
    )
    ko_kds_enabled = fields.Boolean(
        string='ใช้จอครัว (KDS)',
        default=True,
        help='เปิดไว้ = ทุกออเดอร์ของจุดขายนี้ถูกส่งขึ้นจอครัว โดยไม่ต้องพึ่งเครื่องพิมพ์ครัว',
    )
    ko_kds_auto_send_on_payment = fields.Boolean(
        string='ส่งครัวอัตโนมัติหลังชำระเงิน',
        default=True,
        help='ปิดรายการขายแล้วส่งเข้าครัวทันที สำหรับออเดอร์ที่คีย์แล้วชำระเงินเลย',
    )

    def _ko_kds_station_ids(self):
        """Stations usable by this POS, in display order."""
        self.ensure_one()
        stations = self.env['ko.kds.station'].search([])
        return stations._available_for_config(self)


class KdsStation(models.Model):
    _name = 'ko.kds.station'
    _description = 'KDS Station (สถานีครัว)'
    _order = 'sequence, id'

    name = fields.Char(required=True, string='ชื่อสถานี')
    sequence = fields.Integer(default=10, string='ลำดับ')
    active = fields.Boolean(default=True, string='ใช้งาน')
    color = fields.Char(
        string='สีป้าย',
        default='#0e7c86',
        help='สีของป้ายสถานีบนจอครัวและหน้าขาย (เช่น #d9485f)',
    )
    category_ids = fields.Many2many(
        'pos.category',
        'ko_kds_station_categ_rel', 'station_id', 'categ_id',
        string='หมวดสินค้าที่ทำที่สถานีนี้',
        help='รายการในหมวดเหล่านี้จะถูกส่งมาที่สถานีนี้',
    )
    product_tmpl_ids = fields.Many2many(
        'product.template',
        'ko_kds_station_product_rel', 'station_id', 'product_tmpl_id',
        string='เมนูเฉพาะ (ระบุรายตัว)',
        help='ระบุเมนูรายตัวเมื่อไม่อยากผูกทั้งหมวด — เมนูที่ระบุตรงนี้ชนะการจับคู่ด้วยหมวดเสมอ',
    )
    config_ids = fields.Many2many(
        'pos.config',
        string='จุดขาย (POS) ที่ใช้สถานีนี้',
        help='สถานีนี้จะเลือกได้เฉพาะจอครัวของจุดขายที่ระบุ (เว้นว่าง = ใช้ได้ทุกจุดขาย)',
    )
    company_id = fields.Many2one(
        'res.company',
        string='บริษัท',
        help='เว้นว่าง = ใช้ร่วมกันทุกบริษัท',
    )
    is_catch_all = fields.Boolean(
        string='รับรายการที่ไม่เข้าสถานีอื่น',
        compute='_compute_is_catch_all',
        store=True,
        help='สถานีที่ไม่ได้ระบุหมวดและไม่ได้ระบุเมนู จะรับทุกรายการที่ไม่มีสถานีอื่นรับ',
    )

    @api.depends('category_ids', 'product_tmpl_ids')
    def _compute_is_catch_all(self):
        for station in self:
            station.is_catch_all = not station.category_ids and not station.product_tmpl_ids

    def _available_for_config(self, config):
        """Stations usable by one POS: unscoped ones plus ones naming this POS."""
        return self.filtered(
            lambda station: (not station.config_ids or config in station.config_ids)
            and (not station.company_id or not config.company_id
                 or station.company_id == config.company_id)
        )

    @api.model
    def _route(self, config, product):
        """Pick the station that should cook ``product`` for ``config``.

        Priority: an explicit menu match, then a category match, then a
        catch-all station. Returns an empty recordset when nothing matches —
        the line still reaches the board under "ไม่ได้กำหนดสถานี" so an order
        can never disappear because of a configuration gap.
        """
        stations = self.search([])._available_for_config(config) if config else self.search([])
        if not stations:
            return self.browse()
        if product:
            tmpl = product.product_tmpl_id
            named = stations.filtered(lambda s: tmpl in s.product_tmpl_ids)
            if named:
                return named[0]
            categ_ids = set(product.pos_categ_ids.ids)
            if categ_ids:
                by_categ = stations.filtered(lambda s: categ_ids & set(s.category_ids.ids))
                if by_categ:
                    return by_categ[0]
        catch_all = stations.filtered('is_catch_all')
        return catch_all[0] if catch_all else self.browse()

    @api.model
    def _ko_migrate_line_stations(self):
        """Give every ticket line a real station record.

        Runs on each upgrade. Before 19.0.6.0.0 the station was a hard-coded
        ``hot``/``cold``/``drink`` selection on ``pos.category``; those lines
        have no ``station_id`` and would otherwise render as "ไม่ได้กำหนดสถานี".
        Idempotent: it only touches lines that still have no station.
        """
        # The seeded catch-all shipped with sequence 1 before 19.0.6.0.0; push it
        # to the end so real stations lead the chip row. noupdate data cannot do this.
        fallback = self.env.ref('ko_pos_kds.station_kitchen', raise_if_not_found=False)
        if fallback and fallback.is_catch_all and fallback.sequence < 90:
            fallback.sudo().write({'sequence': 99})

        lines = self.env['ko.kds.ticket.line'].sudo().search([('station_id', '=', False)])
        if not lines:
            return True
        migrated = 0
        for line in lines:
            station = self._route(line.ticket_id.config_id, line.product_id)
            if station:
                line.write({'station_id': station.id})
                migrated += 1
        _logger.info('ko_pos_kds: routed %s legacy ticket line(s) to a station record', migrated)
        return True


class KdsTicket(models.Model):
    _name = 'ko.kds.ticket'
    _description = 'KDS Ticket (ตั๋วครัว)'
    _order = 'id desc'

    name = fields.Char(default='/', readonly=True)
    pos_order_uuid = fields.Char(index=True)
    pos_reference = fields.Char(string='เลขที่ออเดอร์')
    tracking_number = fields.Char(string='คิว')
    config_id = fields.Many2one('pos.config', string='POS', index=True)
    company_id = fields.Many2one(
        'res.company',
        string='บริษัท',
        related='config_id.company_id',
        store=True,
        index=True,
        readonly=True,
    )
    table_name = fields.Char(string='โต๊ะ')
    floor_name = fields.Char(string='โซน')
    customer_name = fields.Char(string='ชื่อลูกค้า')
    order_type = fields.Selection([
        ('dinein', 'ทานที่ร้าน'),
        ('takeaway', 'กลับบ้าน'),
    ], default='dinein', string='ประเภท')
    paid = fields.Boolean(default=False, string='ชำระเงินแล้ว')
    remake = fields.Boolean(default=False, string='ทำใหม่')
    internal_note = fields.Text()
    general_customer_note = fields.Text()
    state = fields.Selection([
        ('new', 'ใหม่'),
        ('progress', 'กำลังทำ'),
        ('ready', 'พร้อมเสิร์ฟ'),
        ('served', 'เสิร์ฟแล้ว'),
        ('done', 'เสิร์ฟแล้ว (เดิม)'),
        ('cancelled', 'ยกเลิก'),
    ], default='new', index=True)
    ready_time = fields.Datetime()
    served_time = fields.Datetime()
    done_time = fields.Datetime(help='ฟิลด์เดิม เก็บไว้เพื่อรองรับข้อมูลก่อนอัปเกรด')
    cancelled_time = fields.Datetime()
    line_ids = fields.One2many('ko.kds.ticket.line', 'ticket_id')
    # Bumped whenever the kitchen receives something new for this ticket, so a
    # screen can tell "new items added to table 5" from "table 5 unchanged".
    change_seq = fields.Integer(default=0, readonly=True)

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('name', '/') == '/':
                vals['name'] = self.env['ir.sequence'].next_by_code('ko.kds.ticket') or '/'
        return super().create(vals_list)

    # ------------------------------------------------------------------
    # Notifications
    # ------------------------------------------------------------------

    def _notify_kds(self, event='refresh'):
        """Notify only the screens of the POS each ticket belongs to."""
        by_config = {}
        for ticket in self:
            by_config.setdefault(ticket.config_id.id or 0, []).append(ticket.id)
        for config_id, ticket_ids in by_config.items():
            self.env['bus.bus']._sendone(
                kds_channel(config_id),
                'ko_pos_kds_update',
                {'event': event, 'ticket_ids': ticket_ids, 'config_id': config_id},
            )

    # ------------------------------------------------------------------
    # Ingest from POS
    # ------------------------------------------------------------------

    @api.model
    def _line_values(self, config, raw, cancelled=False):
        product = self.env['product.product'].browse(raw.get('product_id')).exists()
        station = self.env['ko.kds.station']._route(config, product)
        return {
            'pos_order_line_uuid': raw.get('uuid') or raw.get('line_uuid') or '',
            'product_id': product.id or False,
            'full_name': raw.get('name') or raw.get('display_name') or product.display_name or '?',
            'qty': abs(raw.get('quantity') or raw.get('qty') or 0),
            'note': _clean_note(raw.get('note')),
            'customer_note': _clean_note(raw.get('customer_note')),
            'attribute_names': ', '.join(raw.get('attribute_value_names') or []),
            'cancelled': cancelled,
            'done': False,
            'state': 'cancelled' if cancelled else 'cooking',
            'station_id': station.id or False,
            'pos_categ_ids': [(6, 0, product.pos_categ_ids.ids)] if product else False,
        }

    @api.model
    def create_from_pos(self, payload):
        """Upsert one KDS ticket per POS order and apply preparation deltas by line UUID."""
        order_uuid = payload.get('order_uuid')
        if not order_uuid:
            return False

        config_id = payload.get('config_id') or False
        config = self.env['pos.config'].browse(int(config_id)).exists() if config_id else self.env['pos.config']
        # Scope the upsert to the sending POS so two shops can never share a ticket.
        domain = [('pos_order_uuid', '=', order_uuid), ('remake', '=', False)]
        if config_id:
            domain.append(('config_id', '=', config_id))
        ticket = self.sudo().search(domain, order='id desc', limit=1)
        metadata = {
            'pos_reference': payload.get('pos_reference'),
            'tracking_number': str(payload.get('tracking_number') or ''),
            'config_id': config_id,
            'table_name': str(payload.get('table') or ''),
            'floor_name': payload.get('floor') or '',
            'customer_name': (payload.get('customer_name') or '').strip(),
            'order_type': 'takeaway' if not payload.get('table') else 'dinein',
            'paid': bool(payload.get('paid')),
            'internal_note': _clean_note(payload.get('internal_note')),
            'general_customer_note': _clean_note(payload.get('general_customer_note')),
        }
        if not ticket:
            ticket = self.sudo().create({
                **metadata,
                'pos_order_uuid': order_uuid,
            })
        else:
            ticket.sudo().write(metadata)

        added = 0
        for raw in payload.get('new') or []:
            vals = self._line_values(config, raw, cancelled=False)
            line = ticket.line_ids.filtered(
                lambda item, uuid=vals['pos_order_line_uuid']: uuid and item.pos_order_line_uuid == uuid
            )[:1]
            if line:
                line.sudo().write(vals)
            else:
                self.env['ko.kds.ticket.line'].sudo().create({'ticket_id': ticket.id, **vals})
            added += 1

        for raw in payload.get('cancelled') or []:
            vals = self._line_values(config, raw, cancelled=True)
            line = ticket.line_ids.filtered(
                lambda item, uuid=vals['pos_order_line_uuid']: uuid and item.pos_order_line_uuid == uuid
            )[:1]
            if line:
                line.sudo().write({'cancelled': True, 'done': False, 'state': 'cancelled'})
            else:
                self.env['ko.kds.ticket.line'].sudo().create({'ticket_id': ticket.id, **vals})

        live_lines = ticket.line_ids.filtered(lambda line: not line.cancelled)
        if ticket.line_ids and not live_lines:
            ticket.sudo().write({'state': 'cancelled', 'cancelled_time': fields.Datetime.now()})
        elif ticket.state in ('ready', 'served', 'done', 'cancelled') and payload.get('new'):
            ticket.sudo().write({
                'state': 'progress',
                'ready_time': False,
                'served_time': False,
                'cancelled_time': False,
            })

        if added:
            ticket.sudo().write({'change_seq': (ticket.change_seq or 0) + 1})

        ticket._notify_kds('order_changed')
        return ticket.id

    # ------------------------------------------------------------------
    # Kitchen actions
    # ------------------------------------------------------------------

    def set_kds_state(self, state):
        allowed = {'new', 'progress', 'ready', 'served', 'cancelled'}
        if state not in allowed:
            return False
        now = fields.Datetime.now()
        for ticket in self.sudo():
            values = {'state': state}
            if state == 'ready':
                ticket.line_ids.filtered(lambda line: not line.cancelled).write({
                    'done': True,
                    'state': 'ready',
                })
                values['ready_time'] = now
            elif state == 'served':
                ticket.line_ids.filtered(lambda line: not line.cancelled).write({
                    'done': True,
                    'state': 'served',
                })
                values.update({'served_time': now, 'done_time': now})
            elif state == 'cancelled':
                ticket.line_ids.write({'cancelled': True, 'done': False, 'state': 'cancelled'})
                values['cancelled_time'] = now
            ticket.write(values)
        self._notify_kds('state_changed')
        return True

    # ------------------------------------------------------------------
    # Front of house
    # ------------------------------------------------------------------

    @api.model
    def serve_line_from_pos(self, order_uuid, line_uuid):
        line = self.env['ko.kds.ticket.line'].sudo().search([
            ('ticket_id.pos_order_uuid', '=', order_uuid),
            ('ticket_id.remake', '=', False),
            ('pos_order_line_uuid', '=', line_uuid),
            ('cancelled', '=', False),
        ], order='id desc', limit=1)
        if not line:
            return False
        values = {'done': True, 'state': 'served'}
        if line.issue_type and not line.issue_ack:
            # Serving the dish settles whatever the kitchen flagged about it.
            values.update({'issue_ack': True, 'issue_ack_time': fields.Datetime.now()})
        line.write(values)
        ticket = line.ticket_id
        live_lines = ticket.line_ids.filtered(lambda item: not item.cancelled)
        if live_lines and all(item.state == 'served' for item in live_lines):
            ticket.write({
                'state': 'served',
                'served_time': fields.Datetime.now(),
                'done_time': fields.Datetime.now(),
            })
        ticket._notify_kds('served')
        return True

    @api.model
    def ack_issues_from_pos(self, order_uuid, line_uuids=None):
        """Front of house acknowledges kitchen alerts so the red banner clears."""
        domain = [
            ('ticket_id.pos_order_uuid', '=', order_uuid),
            ('issue_type', '!=', False),
            ('issue_ack', '=', False),
        ]
        if line_uuids:
            domain.append(('pos_order_line_uuid', 'in', list(line_uuids)))
        lines = self.env['ko.kds.ticket.line'].sudo().search(domain)
        if not lines:
            return False
        lines.write({'issue_ack': True, 'issue_ack_time': fields.Datetime.now()})
        lines.mapped('ticket_id')._notify_kds('issue_ack')
        return True

    @api.model
    def cancel_by_order_uuid(self, order_uuid, config_id=None):
        domain = [
            ('pos_order_uuid', '=', order_uuid),
            ('state', '!=', 'cancelled'),
        ]
        if config_id:
            domain.append(('config_id', '=', int(config_id)))
        tickets = self.sudo().search(domain)
        if not tickets:
            return False
        tickets.set_kds_state('cancelled')
        return True

    @api.model
    def get_pos_status(self, order_uuids, config_id=None):
        domain = [
            ('pos_order_uuid', 'in', order_uuids or []),
            ('remake', '=', False),
        ]
        if config_id:
            domain.append(('config_id', '=', int(config_id)))
        tickets = self.sudo().search(domain)
        result = {}
        for ticket in tickets:
            result[ticket.pos_order_uuid] = {
                'ticket_id': ticket.id,
                'ticket_name': ticket.name,
                'ticket_state': ticket.state,
                'lines': {
                    line.pos_order_line_uuid: {
                        'state': line.state,
                        'station': line.station_id.name or '',
                        'station_color': line.station_id.color or '',
                        'name': line.full_name,
                        'qty': line.qty,
                        'issue': line._issue_payload(),
                    }
                    for line in ticket.line_ids if line.pos_order_line_uuid
                },
            }
        return result

    def remake_ticket(self):
        self.ensure_one()
        commands = []
        for line in self.line_ids.filtered(lambda item: not item.cancelled):
            commands.append((0, 0, {
                'pos_order_line_uuid': line.pos_order_line_uuid,
                'product_id': line.product_id.id,
                'full_name': line.full_name,
                'qty': line.qty,
                'note': line.note,
                'customer_note': line.customer_note,
                'attribute_names': line.attribute_names,
                'station_id': line.station_id.id,
                'state': 'cooking',
                'pos_categ_ids': [(6, 0, line.pos_categ_ids.ids)],
            }))
        remake = self.sudo().create({
            'pos_order_uuid': self.pos_order_uuid,
            'pos_reference': self.pos_reference,
            'tracking_number': self.tracking_number,
            'config_id': self.config_id.id,
            'table_name': self.table_name,
            'floor_name': self.floor_name,
            'customer_name': self.customer_name,
            'order_type': self.order_type,
            'paid': self.paid,
            'remake': True,
            'internal_note': self.internal_note,
            'general_customer_note': self.general_customer_note,
            'line_ids': commands,
            'change_seq': 1,
        })
        remake._notify_kds('remake')
        return remake.id


class KdsTicketLine(models.Model):
    _name = 'ko.kds.ticket.line'
    _description = 'KDS Ticket Line'
    _order = 'id'

    ticket_id = fields.Many2one('ko.kds.ticket', required=True, ondelete='cascade', index=True)
    company_id = fields.Many2one(
        'res.company',
        string='บริษัท',
        related='ticket_id.company_id',
        store=True,
        index=True,
        readonly=True,
    )
    pos_order_line_uuid = fields.Char(index=True)
    product_id = fields.Many2one('product.product')
    full_name = fields.Char()
    qty = fields.Float()
    note = fields.Char()
    customer_note = fields.Char()
    attribute_names = fields.Char()
    station_id = fields.Many2one(
        'ko.kds.station', string='สถานี', index=True, ondelete='set null',
    )
    state = fields.Selection([
        ('cooking', 'กำลังทำ'),
        ('ready', 'พร้อมเสิร์ฟ'),
        ('served', 'เสิร์ฟแล้ว'),
        ('cancelled', 'ยกเลิก'),
    ], default='cooking', index=True)
    cancelled = fields.Boolean(default=False, help='ฟิลด์เดิมสำหรับข้อมูลก่อนอัปเกรด')
    done = fields.Boolean(default=False, help='ฟิลด์เดิมสำหรับข้อมูลก่อนอัปเกรด')
    pos_categ_ids = fields.Many2many('pos.category', string='หมวด')

    # --- kitchen → front of house alerts -----------------------------
    issue_type = fields.Selection(ISSUE_TYPES, string='ปัญหาจากครัว')
    issue_note = fields.Char(string='หมายเหตุจากครัว')
    issue_time = fields.Datetime(string='เวลาที่แจ้ง')
    issue_user_id = fields.Many2one('res.users', string='ผู้แจ้ง')
    issue_ack = fields.Boolean(default=False, string='หน้าร้านรับทราบแล้ว')
    issue_ack_time = fields.Datetime(string='เวลาที่รับทราบ')

    def _issue_payload(self):
        self.ensure_one()
        if not self.issue_type:
            return None
        return {
            'type': self.issue_type,
            'label': ISSUE_LABELS.get(self.issue_type, self.issue_type),
            'note': self.issue_note or '',
            'ack': self.issue_ack,
            'time': self.issue_time.isoformat() + 'Z' if self.issue_time else None,
        }

    def report_issue(self, issue_type, note=''):
        """The station tells front of house something is wrong with this dish."""
        if issue_type not in ISSUE_LABELS:
            return False
        values = {
            'issue_type': issue_type,
            'issue_note': (note or '').strip()[:250],
            'issue_time': fields.Datetime.now(),
            'issue_user_id': self.env.user.id,
            'issue_ack': False,
            'issue_ack_time': False,
        }
        for line in self.sudo():
            line.write(values)
            if issue_type == 'out_of_stock':
                # Out of stock is terminal for this line: stop the timer, but
                # keep it visible so front of house must acknowledge it.
                line.write({'state': 'cancelled', 'cancelled': True, 'done': False})
                ticket = line.ticket_id
                live = ticket.line_ids.filtered(lambda item: not item.cancelled)
                if ticket.line_ids and not live:
                    ticket.write({'state': 'cancelled', 'cancelled_time': fields.Datetime.now()})
        self.mapped('ticket_id')._notify_kds('issue')
        return True

    def clear_issue(self):
        self.sudo().write({
            'issue_type': False,
            'issue_note': False,
            'issue_time': False,
            'issue_user_id': False,
            'issue_ack': False,
            'issue_ack_time': False,
        })
        self.mapped('ticket_id')._notify_kds('issue_cleared')
        return True

    def toggle_ready(self):
        for line in self.sudo():
            if line.cancelled:
                continue
            ready = line.state != 'ready'
            line.write({'done': ready, 'state': 'ready' if ready else 'cooking'})
            ticket = line.ticket_id
            live_lines = ticket.line_ids.filtered(lambda item: not item.cancelled)
            if live_lines and all(item.state in ('ready', 'served') for item in live_lines):
                ticket.write({'state': 'ready', 'ready_time': fields.Datetime.now()})
            elif ticket.state == 'ready':
                ticket.write({'state': 'progress', 'ready_time': False})
            ticket._notify_kds('line_changed')
        return True
