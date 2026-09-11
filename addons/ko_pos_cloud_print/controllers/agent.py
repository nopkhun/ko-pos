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

Nothing a caller sends decides *where* a job is printed. The POS passes a
printer id and an image; the host, port and paper width are read from the
`pos.printer` record on the server. A request body that could name a host would
turn this endpoint into an open relay onto the shop's LAN.
"""
import base64
import binascii
import json
import logging

from odoo import fields, http
from odoo.exceptions import AccessError
from odoo.http import request

_logger = logging.getLogger(__name__)

# A receipt PNG is a few tens of KB. Two megabytes of base64 is roughly 1.5 MB
# of image — far more than any receipt needs, and small enough that a rogue
# session cannot fill the database with one request.
MAX_IMAGE_B64_CHARS = 2 * 1024 * 1024
PNG_MAGIC = b'\x89PNG\r\n\x1a\n'
# Stop filling a poll response once this much image data is already in it, so a
# backlog cannot produce a response too large for the agent to hold in memory.
MAX_POLL_IMAGE_BYTES = 8 * 1024 * 1024


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


def _check_image(image_png_b64):
    """Validate a submitted receipt image.

    Returns (value, reason). `value` is the base64 string to store or None when
    there is no image; `reason` is set when the submission must be refused.
    """
    if image_png_b64 in (None, False, ''):
        return None, None
    if not isinstance(image_png_b64, str):
        return None, 'nothing_to_print'
    if len(image_png_b64) > MAX_IMAGE_B64_CHARS:
        return None, 'image_too_large'
    try:
        # 32 base64 characters decode to 24 bytes: enough for the magic number,
        # and a multiple of 4 so the decoder never sees a partial group.
        head = base64.b64decode(image_png_b64[:32], validate=True)
    except (binascii.Error, ValueError):
        return None, 'nothing_to_print'
    if not head.startswith(PNG_MAGIC):
        return None, 'nothing_to_print'
    return image_png_b64, None


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

        Job = request.env['ko.print.job'].sudo()
        # Recover anything a previous agent run took and never acknowledged,
        # before deciding what is still queued.
        Job._requeue_stuck(agent)
        jobs = Job._claim_for_agent(agent, max_jobs=data.get('max_jobs', 10))

        payloads = []
        image_bytes = 0
        for job in jobs:
            payload = job._to_agent_payload()
            image = payload.get('image_png_b64') or ''
            # Hand back anything that no longer fits; it stays 'sent' and the
            # stuck-job sweep returns it on a later poll.
            if payloads and image_bytes + len(image) > MAX_POLL_IMAGE_BYTES:
                break
            image_bytes += len(image)
            payloads.append(payload)

        # Stamped last, so the row lock taken by _claim_for_agent is released as
        # soon as possible: a write on ko_print_agent here would hold the
        # transaction open across the whole claim.
        agent._touch(ip=_remote_ip(), agent_version=data.get('agent_version'))
        return _json_response({'jobs': payloads})

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
        # Only a job this agent was actually handed can be closed. Without this
        # a replayed ack could mark a freshly queued receipt as printed.
        if job.state != 'sent':
            return _json_response({'ok': False, 'error': 'not_sent'}, status=404)

        status = 'done' if data.get('status') == 'done' else 'error'
        error = data.get('error')
        job._ack(status, error)
        if status == 'error':
            _logger.warning(
                'ko_pos_cloud_print: agent %s reported job %s failed: %s',
                agent.name, job.id, str(error)[:200].replace('\n', ' '),
            )
        return _json_response({'ok': True, 'job_id': job.id, 'state': job.state})

    # ------------------------------------------------------------------
    # POS endpoint — a logged-in cashier's browser
    # ------------------------------------------------------------------

    @http.route('/ko_print/job', type='jsonrpc', auth='user', methods=['POST'])
    def create_job(self, printer_id=None, image_png_b64=None, cut=True,
                   open_cashdrawer=False, origin=None, config_id=None, **kw):
        """Queue one print job for the shop agent.

        Everything about *where* the job goes is read from the `pos.printer`
        record. The caller only chooses which printer, and only from the
        printers its own POS is configured to use.
        """
        try:
            printer_id = int(printer_id)
        except (TypeError, ValueError):
            return {'ok': False, 'reason': 'no_printer'}

        try:
            config_id = int(config_id)
        except (TypeError, ValueError):
            return {'ok': False, 'reason': 'no_config'}

        # Everything below reads as the calling user, so record rules apply and
        # another company's records are simply not there. A rule that denies the
        # read raises instead of returning nothing, and the POS needs a reason
        # string it can show the cashier, not a traceback.
        try:
            printer = request.env['pos.printer'].browse(printer_id).exists()
            if not printer or printer.printer_type != 'ko_cloud':
                return {'ok': False, 'reason': 'not_a_cloud_printer'}
            if printer.company_id not in request.env.companies:
                return {'ok': False, 'reason': 'not_a_cloud_printer'}

            config = request.env['pos.config'].browse(config_id).exists()
            if not config:
                return {'ok': False, 'reason': 'no_config'}

            # A session may only print on the printers its own POS declares: the
            # kitchen printers, or that POS's customer receipt printer.
            allowed = set(config.printer_ids.ids)
            if config.ko_receipt_printer_id:
                allowed.add(config.ko_receipt_printer_id.id)
            if printer.id not in allowed:
                return {'ok': False, 'reason': 'printer_not_in_config'}

            agent = printer.ko_agent_id.sudo()
        except AccessError:
            return {'ok': False, 'reason': 'not_a_cloud_printer'}

        if not agent:
            return {'ok': False, 'reason': 'no_agent'}
        if not agent.is_online:
            # Deliberately no job: a queue full of receipts that print an hour
            # later, all at once, is worse than no receipt at all. The POS falls
            # back to browser printing instead.
            return {'ok': False, 'reason': 'agent_offline'}

        image, reason = _check_image(image_png_b64)
        if reason:
            return {'ok': False, 'reason': reason}
        if not image and not open_cashdrawer:
            return {'ok': False, 'reason': 'nothing_to_print'}

        vals = {
            'agent_id': agent.id,
            'printer_id': printer.id,
            # Server-side only. The request body never names a host or a port.
            'host': printer.ko_host,
            'port': printer.ko_port or 9100,
            'paper_width': printer.ko_paper_width or '80',
            'image': image or False,
            'cut': bool(cut),
            'open_cashdrawer': bool(open_cashdrawer),
            'origin': (origin if isinstance(origin, str) else '')[:128],
            'config_id': config.id,
        }
        # Cashiers hold no create right on ko.print.job — they must not be able
        # to forge one through the ORM. Creating here is safe because every
        # check above has already passed.
        job = request.env['ko.print.job'].sudo().create(vals)
        return {'ok': True, 'job_id': job.id}
