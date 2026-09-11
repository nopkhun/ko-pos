# -*- coding: utf-8 -*-
import base64
import json

from odoo import fields
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
            'image_png_b64': TINY_PNG,
        })
        self.assertEqual(result, {'ok': False, 'reason': 'not_a_cloud_printer'})
