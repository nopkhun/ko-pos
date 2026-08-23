# -*- coding: utf-8 -*-
import json

from odoo import fields, http
from odoo.http import request


def _json(payload, status=200):
    return request.make_response(
        json.dumps(payload),
        status=status,
        headers=[('Content-Type', 'application/json'), ('Cache-Control', 'no-store')],
    )


class KdsController(http.Controller):

    # ------------------------------------------------------------------
    # Access helpers
    # ------------------------------------------------------------------

    def _check_access(self):
        if not request.env.user.has_group('point_of_sale.group_pos_user'):
            return False
        return True

    def _allowed_configs(self):
        """Every POS this user may look at.

        `pos.config` carries Odoo's standard multi-company record rule, so this
        search already excludes the POS of companies the user is not allowed in.
        """
        return request.env['pos.config'].search([], order='company_id, name, id')

    def _config_or_none(self, config_id):
        """Resolve a POS id to a record the user is allowed to see, else None."""
        try:
            config_id = int(config_id)
        except (TypeError, ValueError):
            return None
        config = self._allowed_configs().filtered(lambda c: c.id == config_id)
        return config[:1] or None

    def _stations_for(self, config):
        return config._ko_kds_station_ids()

    def _ticket_in_scope(self, ticket):
        """A screen may only act on tickets of a POS it is allowed to see."""
        if not ticket:
            return False
        if not ticket.config_id:
            # Legacy tickets from before per-POS scoping: keep them reachable.
            return True
        return ticket.config_id in self._allowed_configs()

    # ------------------------------------------------------------------
    # Screens
    # ------------------------------------------------------------------

    @http.route('/kds', auth='user', type='http', website=False)
    def kds_index(self, **kw):
        """Shop picker. One POS goes straight through; several never get mixed."""
        if not self._check_access():
            return request.make_response('Forbidden', status=403)
        configs = self._allowed_configs()
        if len(configs) == 1:
            return request.redirect('/kds/pos/%s' % configs.id)
        return request.render('ko_pos_kds.kds_choose_page', {
            'configs': configs,
            'multi_company': len(configs.mapped('company_id')) > 1,
        })

    @http.route('/kds/pos/<int:config_id>', auth='user', type='http', website=False)
    def kds_screen(self, config_id, station_id=None, **kw):
        if not self._check_access():
            return request.make_response('Forbidden', status=403)
        config = self._config_or_none(config_id)
        if not config:
            return request.redirect('/kds')
        stations = self._stations_for(config)
        station = stations.filtered(lambda s: str(s.id) == str(station_id))[:1]
        return request.render('ko_pos_kds.kds_page', {
            'stations': stations,
            'station': station,
            'pos_config': config,
            'all_configs': self._allowed_configs(),
            'csrf_token': request.csrf_token(),
        })

    # Old bookmarks pointed at /kds/<station_id>; send them to the picker instead
    # of guessing a shop, so nobody ends up on the wrong kitchen board silently.
    @http.route('/kds/<int:legacy_id>', auth='user', type='http', website=False)
    def kds_legacy(self, legacy_id, **kw):
        return request.redirect('/kds')

    # ------------------------------------------------------------------
    # Data
    # ------------------------------------------------------------------

    @http.route('/kds/data', auth='user', type='http', methods=['GET'])
    def kds_data(self, config_id=None, station_id=None, **kw):
        if not self._check_access():
            return _json({'error': 'forbidden'}, status=403)

        config = self._config_or_none(config_id)
        if not config:
            # Without a POS there is no correct answer — returning every ticket
            # is what made the board show other shops' orders.
            return _json({'error': 'config_required', 'active': [], 'served': [],
                          'cancelled': [], 'now_utc': fields.Datetime.now().isoformat() + 'Z',
                          'sla_minutes': 15}, status=400)

        env = request.env
        stations = self._stations_for(config)
        station = stations.filtered(lambda s: str(s.id) == str(station_id))[:1]

        scope = [('config_id', '=', config.id)]

        # Active includes ready tickets until front of house confirms service.
        active_tickets = env['ko.kds.ticket'].search(
            scope + [('state', 'in', ['new', 'progress', 'ready'])],
            order='id asc', limit=100,
        )

        # Fetch recently served tickets (last 2 hours)
        recent_limit = fields.Datetime.subtract(fields.Datetime.now(), hours=2)
        served_tickets = env['ko.kds.ticket'].search(
            scope + [
                '&', ('state', 'in', ['served', 'done']),
                '|', ('served_time', '>=', recent_limit), ('done_time', '>=', recent_limit),
            ],
            order='served_time desc, done_time desc', limit=50,
        )

        # Fetch cancelled tickets
        cancelled_tickets = env['ko.kds.ticket'].search(
            scope + [('state', '=', 'cancelled'), ('create_date', '>=', recent_limit)],
            order='id desc', limit=30,
        )

        def _format_ticket(t):
            lines = []
            for line in t.line_ids:
                # One screen = one station. When a station is selected the board
                # shows only its own dishes; "ทั้งหมด" shows every station.
                if station and line.station_id != station:
                    continue
                lines.append({
                    'id': line.id,
                    'name': line.full_name,
                    'qty': line.qty,
                    'note': ' '.join(x for x in [line.note, line.customer_note] if x),
                    'attrs': line.attribute_names or '',
                    'station_id': line.station_id.id or 0,
                    'station': line.station_id.name or 'ไม่ได้กำหนดสถานี',
                    'station_color': line.station_id.color or '',
                    'cancelled': line.cancelled,
                    'done': line.done,
                    'state': line.state,
                    'issue': line._issue_payload(),
                })
            if not lines and (station or not (t.internal_note or t.general_customer_note)):
                # A note-only ticket still matters on the unfiltered board.
                return None
            return {
                'id': t.id,
                'name': t.name,
                'ref': t.pos_reference or '',
                'tracking': t.tracking_number or '',
                'table': t.table_name or '',
                'floor': t.floor_name or '',
                'customer': t.customer_name or '',
                'order_type': t.order_type or 'dinein',
                'paid': t.paid,
                'remake': t.remake,
                'change_seq': t.change_seq or 0,
                'note': ' '.join(x for x in [t.internal_note, t.general_customer_note] if x),
                'state': t.state,
                'created_utc': t.create_date.isoformat() + 'Z' if t.create_date else None,
                'done_utc': t.done_time.isoformat() + 'Z' if t.done_time else None,
                'ready_utc': t.ready_time.isoformat() + 'Z' if t.ready_time else None,
                'served_utc': t.served_time.isoformat() + 'Z' if t.served_time else None,
                'cancelled_utc': t.cancelled_time.isoformat() + 'Z' if t.cancelled_time else None,
                'lines': lines,
            }

        active_res = [res for res in (_format_ticket(t) for t in active_tickets) if res]
        served_res = [res for res in (_format_ticket(t) for t in served_tickets) if res]
        cancelled_res = [res for res in (_format_ticket(t) for t in cancelled_tickets) if res]

        return _json({
            'config_id': config.id,
            'config_name': config.display_name,
            'company_name': config.company_id.name or '',
            'station_id': station.id if station else 0,
            'station_name': station.name if station else '',
            'stations': [{'id': s.id, 'name': s.name, 'color': s.color or ''} for s in stations],
            'active': active_res,
            'served': served_res,
            'cancelled': cancelled_res,
            'now_utc': fields.Datetime.now().isoformat() + 'Z',
            'sla_minutes': max(1, config.ko_kds_sla_minutes or 15),
        })

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------

    def _ticket_from_request(self, ticket_id):
        ticket = request.env['ko.kds.ticket'].browse(int(ticket_id)).exists()
        return ticket if self._ticket_in_scope(ticket) else request.env['ko.kds.ticket']

    def _line_from_request(self, line_id):
        line = request.env['ko.kds.ticket.line'].browse(int(line_id)).exists()
        if not line or not self._ticket_in_scope(line.ticket_id):
            return request.env['ko.kds.ticket.line']
        return line

    @http.route('/kds/set_state', auth='user', type='http', methods=['POST'], csrf=True)
    def kds_set_state(self, ticket_id=None, state=None, **kw):
        if not self._check_access() or state not in ('new', 'progress', 'ready', 'served', 'cancelled'):
            return _json({'ok': False})
        ticket = self._ticket_from_request(ticket_id)
        if not ticket:
            return _json({'ok': False, 'error': 'not_allowed'}, status=403)
        ticket.set_kds_state(state)
        return _json({'ok': True})

    @http.route('/kds/toggle_line', auth='user', type='http', methods=['POST'], csrf=True)
    def kds_toggle_line(self, line_id=None, **kw):
        if not self._check_access():
            return _json({'ok': False})
        line = self._line_from_request(line_id)
        if not line:
            return _json({'ok': False, 'error': 'not_allowed'}, status=403)
        line.toggle_ready()
        return _json({'ok': True})

    @http.route('/kds/line_issue', auth='user', type='http', methods=['POST'], csrf=True)
    def kds_line_issue(self, line_id=None, issue_type=None, note=None, **kw):
        """The station tells front of house a dish is out of stock / late / …"""
        if not self._check_access():
            return _json({'ok': False})
        line = self._line_from_request(line_id)
        if not line:
            return _json({'ok': False, 'error': 'not_allowed'}, status=403)
        if not line.report_issue(issue_type, note or ''):
            return _json({'ok': False, 'error': 'bad_issue_type'}, status=400)
        return _json({'ok': True})

    @http.route('/kds/clear_issue', auth='user', type='http', methods=['POST'], csrf=True)
    def kds_clear_issue(self, line_id=None, **kw):
        if not self._check_access():
            return _json({'ok': False})
        line = self._line_from_request(line_id)
        if not line:
            return _json({'ok': False, 'error': 'not_allowed'}, status=403)
        line.clear_issue()
        return _json({'ok': True})

    @http.route('/kds/all_ready', auth='user', type='http', methods=['POST'], csrf=True)
    def kds_all_ready(self, ticket_id=None, line_ids=None, **kw):
        if not self._check_access():
            return _json({'ok': False})
        env = request.env
        if ticket_id:
            ticket = self._ticket_from_request(ticket_id)
            if not ticket:
                return _json({'ok': False, 'error': 'not_allowed'}, status=403)
            ticket.set_kds_state('ready')
        elif line_ids:
            try:
                ids = [int(x) for x in json.loads(line_ids)]
            except (TypeError, ValueError):
                return _json({'ok': False, 'error': 'bad_line_ids'}, status=400)
            lines = env['ko.kds.ticket.line'].browse(ids).exists()
            lines = lines.filtered(lambda line: self._ticket_in_scope(line.ticket_id))
            lines.filtered(lambda line: not line.cancelled).write({'done': True, 'state': 'ready'})
            for ticket in lines.mapped('ticket_id'):
                live_lines = ticket.line_ids.filtered(lambda line: not line.cancelled)
                if live_lines and all(line.state in ('ready', 'served') for line in live_lines):
                    ticket.write({'state': 'ready', 'ready_time': fields.Datetime.now()})
                ticket._notify_kds('batch_ready')
        return _json({'ok': True})

    @http.route('/kds/remake', auth='user', type='http', methods=['POST'], csrf=True)
    def kds_remake(self, ticket_id=None, **kw):
        if not self._check_access():
            return _json({'ok': False})
        ticket = self._ticket_from_request(ticket_id)
        if not ticket:
            return _json({'ok': False, 'error': 'not_allowed'}, status=403)
        ticket.remake_ticket()
        return _json({'ok': True})
