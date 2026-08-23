# -*- coding: utf-8 -*-
import json

from odoo import api, fields, models


STATIONS = [
    ('hot', 'ครัวร้อน'),
    ('cold', 'ครัวเย็น'),
    ('drink', 'เครื่องดื่ม'),
]


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


class PosCategory(models.Model):
    _inherit = 'pos.category'

    ko_kds_station = fields.Selection(
        STATIONS,
        string='สถานีครัว',
        default='hot',
        help='กำหนดว่ารายการในหมวดนี้จะแสดงที่สถานีใดบนจอครัว',
    )

    @api.model
    def _load_pos_data_fields(self, config):
        return [*super()._load_pos_data_fields(config), 'ko_kds_station']


class PosConfig(models.Model):
    _inherit = 'pos.config'

    ko_kds_sla_minutes = fields.Integer(
        string='เวลาเป้าหมายจอครัว (นาที)',
        default=15,
        help='เวลาที่การ์ดออเดอร์เปลี่ยนเป็นสถานะเกินเวลา',
    )


class KdsStation(models.Model):
    _name = 'ko.kds.station'
    _description = 'KDS Station (จุดเตรียมอาหาร)'
    _order = 'sequence, id'

    name = fields.Char(required=True)
    sequence = fields.Integer(default=10)
    active = fields.Boolean(default=True)
    category_ids = fields.Many2many(
        'pos.category',
        string='หมวดสินค้าที่แสดง',
        help='ใช้กรองรายการบนจอของสถานีนี้ (เว้นว่าง = แสดงทุกหมวด)',
    )


class KdsTicket(models.Model):
    _name = 'ko.kds.ticket'
    _description = 'KDS Ticket (ตั๋วครัว)'
    _order = 'id desc'

    name = fields.Char(default='/', readonly=True)
    pos_order_uuid = fields.Char(index=True)
    pos_reference = fields.Char(string='เลขที่ออเดอร์')
    tracking_number = fields.Char(string='คิว')
    config_id = fields.Many2one('pos.config', string='POS')
    table_name = fields.Char(string='โต๊ะ')
    floor_name = fields.Char(string='โซน')
    order_type = fields.Selection([
        ('dinein', 'ทานที่ร้าน'),
        ('takeaway', 'กลับบ้าน'),
    ], default='dinein', string='ประเภท')
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

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('name', '/') == '/':
                vals['name'] = self.env['ir.sequence'].next_by_code('ko.kds.ticket') or '/'
        return super().create(vals_list)

    def _notify_kds(self, event='refresh'):
        payload = {'event': event, 'ticket_ids': self.ids}
        self.env['bus.bus']._sendone('ko_pos_kds', 'ko_pos_kds_update', payload)

    @api.model
    def _station_for_product(self, product):
        category = product.pos_categ_ids.filtered('ko_kds_station')[:1]
        return category.ko_kds_station or 'hot'

    @api.model
    def _line_values(self, raw, cancelled=False):
        product = self.env['product.product'].browse(raw.get('product_id')).exists()
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
            'station': self._station_for_product(product) if product else 'hot',
            'pos_categ_ids': [(6, 0, product.pos_categ_ids.ids)] if product else False,
        }

    @api.model
    def create_from_pos(self, payload):
        """Upsert one KDS ticket per POS order and apply preparation deltas by line UUID."""
        order_uuid = payload.get('order_uuid')
        if not order_uuid:
            return False

        ticket = self.sudo().search([
            ('pos_order_uuid', '=', order_uuid),
            ('remake', '=', False),
        ], order='id desc', limit=1)
        metadata = {
            'pos_reference': payload.get('pos_reference'),
            'tracking_number': str(payload.get('tracking_number') or ''),
            'config_id': payload.get('config_id'),
            'table_name': str(payload.get('table') or ''),
            'floor_name': payload.get('floor') or '',
            'order_type': 'takeaway' if not payload.get('table') else 'dinein',
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

        for raw in payload.get('new') or []:
            vals = self._line_values(raw, cancelled=False)
            line = ticket.line_ids.filtered(
                lambda item, uuid=vals['pos_order_line_uuid']: uuid and item.pos_order_line_uuid == uuid
            )[:1]
            if line:
                line.sudo().write(vals)
            else:
                self.env['ko.kds.ticket.line'].sudo().create({'ticket_id': ticket.id, **vals})

        for raw in payload.get('cancelled') or []:
            vals = self._line_values(raw, cancelled=True)
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

        ticket._notify_kds('order_changed')
        return ticket.id

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
        line.write({'done': True, 'state': 'served'})
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
    def cancel_by_order_uuid(self, order_uuid):
        tickets = self.sudo().search([
            ('pos_order_uuid', '=', order_uuid),
            ('state', '!=', 'cancelled'),
        ])
        if not tickets:
            return False
        tickets.set_kds_state('cancelled')
        return True

    @api.model
    def get_pos_status(self, order_uuids):
        tickets = self.sudo().search([
            ('pos_order_uuid', 'in', order_uuids or []),
            ('remake', '=', False),
        ])
        result = {}
        for ticket in tickets:
            result[ticket.pos_order_uuid] = {
                'ticket_state': ticket.state,
                'lines': {
                    line.pos_order_line_uuid: {
                        'state': line.state,
                        'station': line.station,
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
                'station': line.station,
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
            'order_type': self.order_type,
            'remake': True,
            'internal_note': self.internal_note,
            'general_customer_note': self.general_customer_note,
            'line_ids': commands,
        })
        remake._notify_kds('remake')
        return remake.id


class KdsTicketLine(models.Model):
    _name = 'ko.kds.ticket.line'
    _description = 'KDS Ticket Line'
    _order = 'id'

    ticket_id = fields.Many2one('ko.kds.ticket', required=True, ondelete='cascade', index=True)
    pos_order_line_uuid = fields.Char(index=True)
    product_id = fields.Many2one('product.product')
    full_name = fields.Char()
    qty = fields.Float()
    note = fields.Char()
    customer_note = fields.Char()
    attribute_names = fields.Char()
    station = fields.Selection(STATIONS, default='hot', string='สถานี')
    state = fields.Selection([
        ('cooking', 'กำลังทำ'),
        ('ready', 'พร้อมเสิร์ฟ'),
        ('served', 'เสิร์ฟแล้ว'),
        ('cancelled', 'ยกเลิก'),
    ], default='cooking', index=True)
    cancelled = fields.Boolean(default=False, help='ฟิลด์เดิมสำหรับข้อมูลก่อนอัปเกรด')
    done = fields.Boolean(default=False, help='ฟิลด์เดิมสำหรับข้อมูลก่อนอัปเกรด')
    pos_categ_ids = fields.Many2many('pos.category', string='หมวด')

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
