# -*- coding: utf-8 -*-
"""HTTP surface for the shop print agent and for the POS browser.

Two very different callers live here.

* The **shop agent** is a headless Python process on a PC in the restaurant. It
  has no Odoo session and no cookie; it authenticates with a bearer token on
  every request. Those routes are `auth='public'`, `type='http'` and parse the
  JSON body by hand, because a `type='jsonrpc'` route cannot answer a bare
  HTTP 401 — it wraps everything, errors included, in a JSON-RPC envelope with
  status 200, which is useless for a non-Odoo client.

* The **POS browser** is a logged-in user and calls `/ko_print/job` through
  Odoo's own `rpc()` helper, so that one is a normal `type='jsonrpc'` route.
"""
import json
import logging

from odoo import fields, http
from odoo.http import request

_logger = logging.getLogger(__name__)


def _json_response(payload, status=200):
    return request.make_response(
        json.dumps(payload),
        status=status,
        headers=[('Content-Type', 'application/json'), ('Cache-Control', 'no-store')],
    )


def _unauthorized():
    return _json_response({'error': 'unauthorized'}, status=401)


def _body():
    """Parse the JSON request body, tolerating an empty one."""
    try:
        raw = request.httprequest.get_data(as_text=True)
        if not raw:
            return {}
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except (ValueError, TypeError):
        return {}


def _bearer_token():
    header = request.httprequest.headers.get('Authorization') or ''
    prefix = 'Bearer '
    if not header.startswith(prefix):
        return None
    token = header[len(prefix):].strip()
    return token or None


def _remote_ip():
    return request.httprequest.remote_addr or ''


class KoPrintAgentController(http.Controller):

    # ------------------------------------------------------------------
    # Agent endpoints — bearer token, no session
    # ------------------------------------------------------------------

    def _authenticate(self):
        """Return the agent behind the bearer token, or None."""
        token = _bearer_token()
        if not token:
            return None
        agent = request.env['ko.print.agent'].sudo()._find_by_token(token)
        return agent or None

    @http.route('/ko_print/agent/ping', type='http', auth='public', methods=['POST'],
                csrf=False, save_session=False)
    def agent_ping(self, **kw):
        agent = self._authenticate()
        if not agent:
            return _unauthorized()
        data = _body()
        agent._touch(ip=_remote_ip(), agent_version=data.get('agent_version'))
        return _json_response({
            'ok': True,
            'agent': {'id': agent.id, 'name': agent.name},
            'server_time': fields.Datetime.now().isoformat(),
        })

    @http.route('/ko_print/agent/poll', type='http', auth='public', methods=['POST'],
                csrf=False, save_session=False)
    def agent_poll(self, **kw):
        agent = self._authenticate()
        if not agent:
            return _unauthorized()
        data = _body()
        agent._touch(ip=_remote_ip(), agent_version=data.get('agent_version'))

        Job = request.env['ko.print.job'].sudo()
        # Recover anything a previous agent run took and never acknowledged,
        # before deciding what is still queued.
        Job._requeue_stuck(agent)
        jobs = Job._claim_for_agent(agent, max_jobs=data.get('max_jobs', 10))
        return _json_response({'jobs': [job._to_agent_payload() for job in jobs]})

    @http.route('/ko_print/agent/ack', type='http', auth='public', methods=['POST'],
                csrf=False, save_session=False)
    def agent_ack(self, **kw):
        agent = self._authenticate()
        if not agent:
            return _unauthorized()
        data = _body()
        agent._touch(ip=_remote_ip(), agent_version=data.get('agent_version'))

        try:
            job_id = int(data.get('job_id'))
        except (TypeError, ValueError):
            return _json_response({'ok': False, 'error': 'bad_job_id'}, status=400)

        job = request.env['ko.print.job'].sudo().browse(job_id).exists()
        # An agent may only close its own jobs.
        if not job or job.agent_id != agent:
            return _json_response({'ok': False, 'error': 'not_found'}, status=404)

        status = 'done' if data.get('status') == 'done' else 'error'
        job._ack(status, data.get('error'))
        if status == 'error':
            _logger.warning(
                'ko_pos_cloud_print: agent %s reported job %s failed: %s',
                agent.name, job.id, data.get('error'),
            )
        return _json_response({'ok': True, 'job_id': job.id, 'state': job.state})

    # ------------------------------------------------------------------
    # POS endpoint — a logged-in cashier's browser
    # ------------------------------------------------------------------

    @http.route('/ko_print/job', type='jsonrpc', auth='user', methods=['POST'])
    def create_job(self, printer_id=None, image_png_b64=None, cut=True,
                   open_cashdrawer=False, origin=None, config_id=None, **kw):
        try:
            printer_id = int(printer_id)
        except (TypeError, ValueError):
            return {'ok': False, 'reason': 'no_printer'}

        printer = request.env['pos.printer'].sudo().browse(printer_id).exists()
        if not printer or printer.printer_type != 'ko_cloud':
            return {'ok': False, 'reason': 'not_a_cloud_printer'}

        agent = printer.ko_agent_id
        if not agent:
            return {'ok': False, 'reason': 'no_agent'}
        if not agent.is_online:
            # Deliberately no job: a queue full of receipts that print an hour
            # later, all at once, is worse than no receipt at all. The POS falls
            # back to browser printing instead.
            return {'ok': False, 'reason': 'agent_offline'}

        if not image_png_b64 and not open_cashdrawer:
            return {'ok': False, 'reason': 'nothing_to_print'}

        vals = {
            'agent_id': agent.id,
            'printer_id': printer.id,
            'host': printer.ko_host,
            'port': printer.ko_port or 9100,
            'paper_width': printer.ko_paper_width or '80',
            'image': image_png_b64 or False,
            'cut': bool(cut),
            'open_cashdrawer': bool(open_cashdrawer),
            'origin': (origin or '')[:128],
        }
        if config_id:
            try:
                vals['config_id'] = int(config_id)
            except (TypeError, ValueError):
                pass

        job = request.env['ko.print.job'].create(vals)
        return {'ok': True, 'job_id': job.id}
