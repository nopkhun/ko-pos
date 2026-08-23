# -*- coding: utf-8 -*-
import json

from odoo import fields, http
from odoo.http import request


class KdsController(http.Controller):

    def _check_access(self):
        if not request.env.user.has_group('point_of_sale.group_pos_user'):
            return False
        return True

    @http.route(['/kds', '/kds/<int:station_id>'], auth='user', type='http', website=False)
    def kds_screen(self, station_id=None, **kw):
        if not self._check_access():
            return request.make_response('Forbidden', status=403)
        stations = request.env['ko.kds.station'].search([])
        station = stations.filtered(lambda s: s.id == station_id) or stations[:1]
        active_session = request.env['pos.session'].search([
            ('state', 'in', ['opening_control', 'opened']),
            ('rescue', '=', False),
        ], limit=1)
        pos_config = active_session.config_id
        if not pos_config:
            pos_config = request.env['pos.config'].search([], limit=1)
        return request.render('ko_pos_kds.kds_page', {
            'stations': stations,
            'station': station,
            'pos_config': pos_config,
            'csrf_token': request.csrf_token(),
        })

    @http.route('/kds/data', auth='user', type='http', methods=['GET'])
    def kds_data(self, station_id=None, **kw):
        if not self._check_access():
            return request.make_response('{"error": "forbidden"}', headers=[('Content-Type', 'application/json')])
        env = request.env
        station = env['ko.kds.station'].browse(int(station_id)) if station_id else env['ko.kds.station']
        categ_ids = set(station.category_ids.ids) if station and station.category_ids else None

        # Active includes ready tickets until front of house confirms service.
        active_tickets = env['ko.kds.ticket'].search([
            ('state', 'in', ['new', 'progress', 'ready']),
        ], order='id asc', limit=100)

        # Fetch recently served tickets (last 2 hours)
        recent_limit = fields.Datetime.subtract(fields.Datetime.now(), hours=2)
        served_tickets = env['ko.kds.ticket'].search([
            '&', ('state', 'in', ['served', 'done']),
            '|', ('served_time', '>=', recent_limit), ('done_time', '>=', recent_limit),
        ], order='served_time desc, done_time desc', limit=50)

        # Fetch cancelled tickets
        cancelled_tickets = env['ko.kds.ticket'].search([
            ('state', '=', 'cancelled'),
            ('create_date', '>=', recent_limit),
        ], order='id desc', limit=30)

        def _format_ticket(t):
            lines = []
            for line in t.line_ids:
                if categ_ids is not None and line.pos_categ_ids and not (set(line.pos_categ_ids.ids) & categ_ids):
                    continue
                lines.append({
                    'id': line.id,
                    'name': line.full_name,
                    'qty': line.qty,
                    'note': ' '.join(x for x in [line.note, line.customer_note] if x),
                    'attrs': line.attribute_names or '',
                    'station': line.station or 'hot',
                    'cancelled': line.cancelled,
                    'done': line.done,
                    'state': line.state,
                })
            if not lines and not t.internal_note and not t.general_customer_note:
                return None
            return {
                'id': t.id,
                'name': t.name,
                'ref': t.pos_reference or '',
                'tracking': t.tracking_number or '',
                'table': t.table_name or '',
                'floor': t.floor_name or '',
                'order_type': t.order_type or 'dinein',
                'remake': t.remake,
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

        config = active_tickets[:1].config_id or served_tickets[:1].config_id
        if not config:
            config = env['pos.config'].search([], limit=1)

        return request.make_response(
            json.dumps({
                'active': active_res,
                'served': served_res,
                'cancelled': cancelled_res,
                'now_utc': fields.Datetime.now().isoformat() + 'Z',
                'sla_minutes': max(1, config.ko_kds_sla_minutes or 15),
            }),
            headers=[('Content-Type', 'application/json'), ('Cache-Control', 'no-store')],
        )

    @http.route('/kds/set_state', auth='user', type='http', methods=['POST'], csrf=True)
    def kds_set_state(self, ticket_id=None, state=None, **kw):
        if not self._check_access() or state not in ('new', 'progress', 'ready', 'served', 'cancelled'):
            return request.make_response('{"ok": false}', headers=[('Content-Type', 'application/json')])
        ticket = request.env['ko.kds.ticket'].browse(int(ticket_id)).exists()
        if ticket:
            ticket.set_kds_state(state)
        return request.make_response('{"ok": true}', headers=[('Content-Type', 'application/json')])

    @http.route('/kds/toggle_line', auth='user', type='http', methods=['POST'], csrf=True)
    def kds_toggle_line(self, line_id=None, **kw):
        if not self._check_access():
            return request.make_response('{"ok": false}', headers=[('Content-Type', 'application/json')])
        line = request.env['ko.kds.ticket.line'].browse(int(line_id)).exists()
        if line:
            line.toggle_ready()
        return request.make_response('{"ok": true}', headers=[('Content-Type', 'application/json')])

    @http.route('/kds/all_ready', auth='user', type='http', methods=['POST'], csrf=True)
    def kds_all_ready(self, ticket_id=None, line_ids=None, **kw):
        if not self._check_access():
            return request.make_response('{"ok": false}', headers=[('Content-Type', 'application/json')])
        env = request.env
        if ticket_id:
            ticket = env['ko.kds.ticket'].browse(int(ticket_id)).exists()
            if ticket:
                ticket.set_kds_state('ready')
        elif line_ids:
            try:
                ids = [int(x) for x in json.loads(line_ids)]
                lines = env['ko.kds.ticket.line'].browse(ids).exists()
                lines.filtered(lambda line: not line.cancelled).write({'done': True, 'state': 'ready'})
                for ticket in lines.mapped('ticket_id'):
                    live_lines = ticket.line_ids.filtered(lambda line: not line.cancelled)
                    if live_lines and all(line.state in ('ready', 'served') for line in live_lines):
                        ticket.write({'state': 'ready', 'ready_time': fields.Datetime.now()})
                    ticket._notify_kds('batch_ready')
            except Exception:
                pass
        return request.make_response('{"ok": true}', headers=[('Content-Type', 'application/json')])

    @http.route('/kds/remake', auth='user', type='http', methods=['POST'], csrf=True)
    def kds_remake(self, ticket_id=None, **kw):
        if not self._check_access():
            return request.make_response('{"ok": false}', headers=[('Content-Type', 'application/json')])
        ticket = request.env['ko.kds.ticket'].browse(int(ticket_id)).exists()
        if ticket:
            ticket.remake_ticket()
        return request.make_response('{"ok": true}', headers=[('Content-Type', 'application/json')])
