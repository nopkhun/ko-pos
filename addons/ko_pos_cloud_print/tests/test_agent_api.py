# -*- coding: utf-8 -*-
import base64
import json

from odoo import fields
from odoo.exceptions import AccessError
from odoo.tests import HttpCase, tagged

# A 1x1 transparent PNG. Enough to prove the image survives the round trip.
TINY_PNG = base64.b64encode(base64.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk'
    'YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
)).decode()


@tagged('post_install', '-at_install')
class TestKoPrintAgentApi(HttpCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # The POS endpoint is auth='user' and guarded by the POS ACLs; make sure
        # the account the test logs in with actually holds them.
        cls.env.ref('base.user_admin').sudo().write({
            'group_ids': [(4, cls.env.ref('point_of_sale.group_pos_manager').id)],
        })
        cls.agent = cls.env['ko.print.agent'].create({'name': 'QA agent'})
        cls.printer = cls.env['pos.printer'].create({
            'name': 'QA cloud printer',
            'printer_type': 'ko_cloud',
            'ko_agent_id': cls.agent.id,
            'ko_host': '192.168.1.50',
            'ko_port': 9100,
            'ko_paper_width': '80',
        })
        # /ko_print/job only accepts a printer its POS actually declares.
        cls.config = cls.env['pos.config'].create({'name': 'QA cloud print shop'})
        cls.config.write({'ko_receipt_printer_id': cls.printer.id})

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------

    def _post(self, path, payload, token=None):
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer %s' % token
        return self.url_open(path, data=json.dumps(payload), headers=headers)

    def _token(self):
        return self.agent.sudo().token

    def _make_job(self, **overrides):
        vals = {
            'agent_id': self.agent.id,
            'printer_id': self.printer.id,
            'host': self.printer.ko_host,
            'port': 9100,
            'paper_width': '80',
            'image': TINY_PNG,
            'origin': 'QA-0001',
        }
        vals.update(overrides)
        return self.env['ko.print.job'].create(vals)

    # ------------------------------------------------------------------
    # ping
    # ------------------------------------------------------------------

    def test_ping_without_token_is_401(self):
        response = self._post('/ko_print/agent/ping', {'agent_version': '1.0'})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json(), {'error': 'unauthorized'})

    def test_ping_with_wrong_token_is_401(self):
        response = self._post('/ko_print/agent/ping', {'agent_version': '1.0'}, token='nope')
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json(), {'error': 'unauthorized'})

    def test_ping_updates_last_seen(self):
        self.agent.sudo().write({'last_seen': False, 'agent_version': False})
        response = self._post('/ko_print/agent/ping', {'agent_version': '1.2.3'}, token=self._token())
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body['ok'])
        self.assertEqual(body['agent']['id'], self.agent.id)
        self.assertTrue(body['server_time'])

        self.agent.invalidate_recordset()
        self.assertTrue(self.agent.last_seen, 'ping must stamp last_seen')
        self.assertEqual(self.agent.agent_version, '1.2.3')
        self.assertTrue(self.agent.is_online)

    # ------------------------------------------------------------------
    # poll / ack
    # ------------------------------------------------------------------

    def test_poll_returns_queued_job_and_marks_it_sent(self):
        job = self._make_job()
        response = self._post('/ko_print/agent/poll', {'max_jobs': 10}, token=self._token())
        self.assertEqual(response.status_code, 200)
        jobs = response.json()['jobs']
        self.assertEqual([j['id'] for j in jobs], [job.id])

        payload = jobs[0]
        self.assertEqual(payload['host'], '192.168.1.50')
        self.assertEqual(payload['port'], 9100)
        self.assertEqual(payload['paper_width'], 80)
        self.assertEqual(payload['image_png_b64'], TINY_PNG)
        self.assertTrue(payload['cut'])
        self.assertFalse(payload['open_cashdrawer'])
        self.assertEqual(payload['origin'], 'QA-0001')

        job.invalidate_recordset()
        self.assertEqual(job.state, 'sent')
        self.assertEqual(job.attempts, 1)

        # A second poll must not hand the same job out again.
        again = self._post('/ko_print/agent/poll', {}, token=self._token())
        self.assertEqual(again.json()['jobs'], [])

    def test_poll_requires_token(self):
        self._make_job()
        response = self._post('/ko_print/agent/poll', {}, token='wrong')
        self.assertEqual(response.status_code, 401)

    def test_ack_done(self):
        job = self._make_job()
        self._post('/ko_print/agent/poll', {}, token=self._token())
        response = self._post(
            '/ko_print/agent/ack', {'job_id': job.id, 'status': 'done'}, token=self._token())
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()['ok'])

        job.invalidate_recordset()
        self.assertEqual(job.state, 'done')

    def test_ack_error_stores_the_message(self):
        job = self._make_job()
        self._post('/ko_print/agent/poll', {}, token=self._token())
        self._post(
            '/ko_print/agent/ack',
            {'job_id': job.id, 'status': 'error', 'error': 'connection refused'},
            token=self._token(),
        )
        job.invalidate_recordset()
        self.assertEqual(job.state, 'error')
        self.assertIn('connection refused', job.error)

    def test_ack_is_refused_on_a_job_that_was_never_sent(self):
        """A replayed ack must not mark a freshly queued receipt as printed."""
        job = self._make_job()
        response = self._post(
            '/ko_print/agent/ack', {'job_id': job.id, 'status': 'done'}, token=self._token())
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()['error'], 'not_sent')
        job.invalidate_recordset()
        self.assertEqual(job.state, 'queued')

    def test_stuck_sent_job_is_requeued(self):
        """An agent that dies mid-job must not swallow the receipt."""
        job = self._make_job()
        long_ago = fields.Datetime.subtract(fields.Datetime.now(), seconds=120)
        job.write({'state': 'sent', 'attempts': 1})
        # write_date is what _requeue_stuck reads, and the ORM owns it. Flush the
        # pending write first: otherwise it lands *after* this raw UPDATE and
        # stamps write_date back to now.
        self.env.flush_all()
        self.env.cr.execute(
            'UPDATE ko_print_job SET write_date = %s WHERE id = %s', (long_ago, job.id))
        job.invalidate_recordset()

        response = self._post('/ko_print/agent/poll', {}, token=self._token())
        jobs = response.json()['jobs']
        self.assertEqual([j['id'] for j in jobs], [job.id], 'stuck job should come back')

        job.invalidate_recordset()
        self.assertEqual(job.state, 'sent')
        self.assertEqual(job.attempts, 2, 'the retry must count')

    def test_stuck_sent_job_gives_up_after_max_attempts(self):
        job = self._make_job()
        long_ago = fields.Datetime.subtract(fields.Datetime.now(), seconds=120)
        job.write({'state': 'sent', 'attempts': 3})
        self.env.flush_all()
        self.env.cr.execute(
            'UPDATE ko_print_job SET write_date = %s WHERE id = %s', (long_ago, job.id))
        job.invalidate_recordset()

        response = self._post('/ko_print/agent/poll', {}, token=self._token())
        self.assertEqual(response.json()['jobs'], [])
        job.invalidate_recordset()
        self.assertEqual(job.state, 'error')

    # ------------------------------------------------------------------
    # POS side
    # ------------------------------------------------------------------

    def test_pos_job_refused_when_agent_offline(self):
        self.agent.sudo().write({'last_seen': False})
        self.authenticate('admin', 'admin')
        before = self.env['ko.print.job'].search_count([])
        result = self.make_jsonrpc_request('/ko_print/job', {
            'printer_id': self.printer.id,
            'config_id': self.config.id,
            'image_png_b64': TINY_PNG,
            'origin': 'QA-offline',
        })
        self.assertEqual(result, {'ok': False, 'reason': 'agent_offline'})
        self.assertEqual(
            self.env['ko.print.job'].search_count([]), before,
            'an offline agent must not accumulate a queue of stale receipts')

    def test_pos_job_created_when_agent_online(self):
        self.agent.sudo().write({'last_seen': fields.Datetime.now()})
        self.authenticate('admin', 'admin')
        result = self.make_jsonrpc_request('/ko_print/job', {
            'printer_id': self.printer.id,
            'config_id': self.config.id,
            'image_png_b64': TINY_PNG,
            'origin': 'QA-online',
        })
        self.assertTrue(result['ok'])
        job = self.env['ko.print.job'].browse(result['job_id'])
        self.assertEqual(job.state, 'queued')
        self.assertEqual(job.host, '192.168.1.50')
        self.assertEqual(job.agent_id, self.agent)
        self.assertEqual(job.origin, 'QA-online')

    def test_pos_job_drawer_only_needs_no_image(self):
        self.agent.sudo().write({'last_seen': fields.Datetime.now()})
        self.authenticate('admin', 'admin')
        result = self.make_jsonrpc_request('/ko_print/job', {
            'printer_id': self.printer.id,
            'config_id': self.config.id,
            'image_png_b64': None,
            'cut': False,
            'open_cashdrawer': True,
            'origin': 'cashdrawer',
        })
        self.assertTrue(result['ok'])
        job = self.env['ko.print.job'].browse(result['job_id'])
        self.assertTrue(job.open_cashdrawer)
        self.assertFalse(job.image)

    def test_pos_job_rejects_a_non_cloud_printer(self):
        other = self.env['pos.printer'].create({
            'name': 'QA epson', 'printer_type': 'epson_epos', 'epson_printer_ip': '1.2.3.4'})
        self.authenticate('admin', 'admin')
        result = self.make_jsonrpc_request('/ko_print/job', {
            'printer_id': other.id,
            'config_id': self.config.id,
            'image_png_b64': TINY_PNG,
        })
        self.assertEqual(result, {'ok': False, 'reason': 'not_a_cloud_printer'})

    # ------------------------------------------------------------------
    # Authorization and input validation
    # ------------------------------------------------------------------

    def test_pos_user_cannot_create_a_job_through_the_orm(self):
        """Cashiers hold no create right: a job may only appear via the route.

        Without this, any POS session could forge a job naming an arbitrary
        host and use the shop agent as a relay onto the local network.
        """
        cashier = self.env['res.users'].create({
            'name': 'QA cashier', 'login': 'qa_cashier_cloud_print',
            'group_ids': [(6, 0, [self.env.ref('point_of_sale.group_pos_user').id])],
        })
        JobAsCashier = self.env['ko.print.job'].with_user(cashier)
        with self.assertRaises(AccessError):
            JobAsCashier.create({
                'agent_id': self.agent.id,
                'host': '10.0.0.1',
                'port': 9100,
                'image': TINY_PNG,
            })
        # ... and cannot read other people's receipt images either.
        with self.assertRaises(AccessError):
            JobAsCashier.search([])

    def test_pos_job_rejects_a_printer_from_another_company(self):
        other_company = self.env['res.company'].create({'name': 'QA other company'})
        other_agent = self.env['ko.print.agent'].create({
            'name': 'QA other agent', 'company_id': other_company.id})
        other_printer = self.env['pos.printer'].create({
            'name': 'QA other printer',
            'printer_type': 'ko_cloud',
            'company_id': other_company.id,
            'ko_agent_id': other_agent.id,
            'ko_host': '10.9.9.9',
        })
        self.authenticate('admin', 'admin')
        before = self.env['ko.print.job'].search_count([])
        result = self.make_jsonrpc_request('/ko_print/job', {
            'printer_id': other_printer.id,
            'config_id': self.config.id,
            'image_png_b64': TINY_PNG,
        })
        self.assertEqual(result, {'ok': False, 'reason': 'not_a_cloud_printer'})
        self.assertEqual(self.env['ko.print.job'].search_count([]), before)

    def test_pos_job_rejects_a_printer_not_attached_to_that_pos(self):
        stray = self.env['pos.printer'].create({
            'name': 'QA stray printer',
            'printer_type': 'ko_cloud',
            'ko_agent_id': self.agent.id,
            'ko_host': '192.168.1.99',
        })
        other_config = self.env['pos.config'].create({'name': 'QA other shop'})
        self.agent.sudo().write({'last_seen': fields.Datetime.now()})
        self.authenticate('admin', 'admin')
        before = self.env['ko.print.job'].search_count([])

        # Right company, real cloud printer, but this POS never declared it.
        result = self.make_jsonrpc_request('/ko_print/job', {
            'printer_id': stray.id,
            'config_id': self.config.id,
            'image_png_b64': TINY_PNG,
        })
        self.assertEqual(result, {'ok': False, 'reason': 'printer_not_in_config'})

        # Same printer, a POS that does not own it either.
        result = self.make_jsonrpc_request('/ko_print/job', {
            'printer_id': self.printer.id,
            'config_id': other_config.id,
            'image_png_b64': TINY_PNG,
        })
        self.assertEqual(result, {'ok': False, 'reason': 'printer_not_in_config'})
        self.assertEqual(self.env['ko.print.job'].search_count([]), before)

    def test_pos_job_requires_a_config(self):
        self.agent.sudo().write({'last_seen': fields.Datetime.now()})
        self.authenticate('admin', 'admin')
        result = self.make_jsonrpc_request('/ko_print/job', {
            'printer_id': self.printer.id,
            'image_png_b64': TINY_PNG,
        })
        self.assertEqual(result, {'ok': False, 'reason': 'no_config'})

    def test_pos_job_rejects_an_oversized_image(self):
        self.agent.sudo().write({'last_seen': fields.Datetime.now()})
        self.authenticate('admin', 'admin')
        before = self.env['ko.print.job'].search_count([])
        result = self.make_jsonrpc_request('/ko_print/job', {
            'printer_id': self.printer.id,
            'config_id': self.config.id,
            'image_png_b64': 'A' * (2 * 1024 * 1024 + 4),
        })
        self.assertEqual(result, {'ok': False, 'reason': 'image_too_large'})
        self.assertEqual(self.env['ko.print.job'].search_count([]), before)

    def test_pos_job_rejects_a_non_png_payload(self):
        self.agent.sudo().write({'last_seen': fields.Datetime.now()})
        self.authenticate('admin', 'admin')
        before = self.env['ko.print.job'].search_count([])
        # Valid base64, but a GIF rather than a PNG.
        gif = base64.b64encode(b'GIF89a' + b'\x00' * 32).decode()
        for payload, reason in [
            (gif, 'nothing_to_print'),
            ('not valid base64 !!!!', 'nothing_to_print'),
            (12345, 'nothing_to_print'),
        ]:
            result = self.make_jsonrpc_request('/ko_print/job', {
                'printer_id': self.printer.id,
                'config_id': self.config.id,
                'image_png_b64': payload,
            })
            self.assertEqual(result, {'ok': False, 'reason': reason}, payload)
        self.assertEqual(self.env['ko.print.job'].search_count([]), before)

    def test_pos_job_never_takes_host_or_port_from_the_request(self):
        """The body may say anything; the printer record decides."""
        self.agent.sudo().write({'last_seen': fields.Datetime.now()})
        self.authenticate('admin', 'admin')
        result = self.make_jsonrpc_request('/ko_print/job', {
            'printer_id': self.printer.id,
            'config_id': self.config.id,
            'image_png_b64': TINY_PNG,
            'host': '10.0.0.66',
            'port': 4444,
            'paper_width': '58',
            'agent_id': 999,
            'state': 'done',
        })
        self.assertTrue(result['ok'])
        job = self.env['ko.print.job'].browse(result['job_id'])
        self.assertEqual(job.host, '192.168.1.50')
        self.assertEqual(job.port, 9100)
        self.assertEqual(job.paper_width, '80')
        self.assertEqual(job.agent_id, self.agent)
        self.assertEqual(job.state, 'queued')

    def test_non_string_origin_is_dropped(self):
        self.agent.sudo().write({'last_seen': fields.Datetime.now()})
        self.authenticate('admin', 'admin')
        result = self.make_jsonrpc_request('/ko_print/job', {
            'printer_id': self.printer.id,
            'config_id': self.config.id,
            'image_png_b64': TINY_PNG,
            'origin': {'evil': True},
        })
        self.assertTrue(result['ok'])
        self.assertFalse(self.env['ko.print.job'].browse(result['job_id']).origin)

    def test_a_short_token_is_rejected_without_touching_the_table(self):
        response = self._post('/ko_print/agent/ping', {}, token='too-short')
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json(), {'error': 'unauthorized'})

    def test_printer_and_agent_must_share_a_company(self):
        from odoo.exceptions import UserError
        other_company = self.env['res.company'].create({'name': 'QA mismatch company'})
        stranger = self.env['ko.print.agent'].create({
            'name': 'QA stranger agent', 'company_id': other_company.id})
        with self.assertRaises(UserError):
            self.env['pos.printer'].create({
                'name': 'QA mismatched printer',
                'printer_type': 'ko_cloud',
                'ko_agent_id': stranger.id,
                'ko_host': '192.168.1.77',
            })
