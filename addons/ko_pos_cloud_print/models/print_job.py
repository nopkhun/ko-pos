# -*- coding: utf-8 -*-
import logging

from odoo import api, fields, models

_logger = logging.getLogger(__name__)

# A job handed to an agent that has not been acknowledged within this many
# seconds is assumed lost (agent crashed, PC slept, network dropped).
STUCK_SENT_SECONDS = 60
# How many times we hand the same job back before giving up on it. Without a
# ceiling a printer that is jammed would be retried forever.
MAX_ATTEMPTS = 3
# Jobs are troubleshooting data, not accounting data.
GC_DAYS = 7

PAPER_WIDTHS = [
    ('58', '58 mm'),
    ('80', '80 mm'),
]


class KoPrintJob(models.Model):
    _name = 'ko.print.job'
    _description = 'KO Print Job'
    # Oldest first: a receipt must not print after the ticket that follows it.
    _order = 'id asc'

    agent_id = fields.Many2one(
        'ko.print.agent', string='Print Agent', required=True,
        ondelete='cascade', index=True,
    )
    printer_id = fields.Many2one('pos.printer', string='Printer', ondelete='set null')
    host = fields.Char(string='Printer Host')
    port = fields.Integer(string='Printer Port', default=9100)
    paper_width = fields.Selection(PAPER_WIDTHS, string='Paper Width', default='80')
    # attachment=False on purpose: the filestore is not shared with the QA/staging
    # copies of this database, and a print job is short-lived rubbish anyway.
    image = fields.Binary(string='Image (PNG)', attachment=False)
    cut = fields.Boolean(string='Cut Paper', default=True)
    open_cashdrawer = fields.Boolean(string='Open Cash Drawer', default=False)
    state = fields.Selection(
        [
            ('queued', 'Queued'),
            ('sent', 'Sent to Agent'),
            ('done', 'Printed'),
            ('error', 'Failed'),
        ],
        string='Status', default='queued', required=True, index=True,
    )
    error = fields.Text(string='Error', readonly=True)
    attempts = fields.Integer(string='Attempts', default=0, readonly=True)
    origin = fields.Char(string='Origin', help='Order name, or "kitchen" for a preparation ticket.')
    config_id = fields.Many2one('pos.config', string='Point of Sale', ondelete='set null')
    company_id = fields.Many2one(
        'res.company', string='Company', related='agent_id.company_id',
        store=True, index=True, readonly=True,
    )

    # The agent polls "my queued jobs, oldest first" every couple of seconds.
    # Odoo 19 ignores _sql_constraints, so this is declared as models.Index.
    _agent_state_idx = models.Index('(agent_id, state)')

    @api.depends('origin')
    def _compute_display_name(self):
        for job in self:
            job.display_name = '%s #%s' % (job.origin or 'print', job.id)

    # ------------------------------------------------------------------
    # Agent protocol
    # ------------------------------------------------------------------

    @api.model
    def _requeue_stuck(self, agent):
        """Hand back jobs an agent took but never acknowledged.

        Anything still `sent` after STUCK_SENT_SECONDS is assumed lost. Under the
        attempt ceiling it goes back in the queue; at or over it, it is parked as
        an error so it stops cycling and shows up in the troubleshooting list.
        """
        cutoff = fields.Datetime.subtract(fields.Datetime.now(), seconds=STUCK_SENT_SECONDS)
        stuck = self.sudo().search([
            ('agent_id', '=', agent.id),
            ('state', '=', 'sent'),
            ('write_date', '<', cutoff),
        ])
        if not stuck:
            return
        retryable = stuck.filtered(lambda j: j.attempts < MAX_ATTEMPTS)
        exhausted = stuck - retryable
        if retryable:
            retryable.write({'state': 'queued'})
        if exhausted:
            exhausted.write({
                'state': 'error',
                'error': 'No acknowledgement from the agent after %s attempts.' % MAX_ATTEMPTS,
            })

    @api.model
    def _claim_for_agent(self, agent, max_jobs=10):
        """Atomically take up to `max_jobs` queued jobs for this agent.

        Two agent processes (or one agent polling twice because the first reply
        was slow) must never be handed the same receipt. `FOR UPDATE SKIP LOCKED`
        lets the second caller walk straight past rows the first one already
        holds instead of blocking on them or duplicating them.
        """
        try:
            max_jobs = max(1, min(int(max_jobs or 10), 50))
        except (TypeError, ValueError):
            max_jobs = 10

        # The SELECT below is raw SQL, so anything the ORM is still holding in
        # memory is invisible to it. `_requeue_stuck` runs immediately before
        # this and puts jobs back to 'queued' through the ORM: without the flush
        # those jobs stay 'sent' in the database and are never handed back.
        self.env.flush_all()

        self.env.cr.execute(
            """
            SELECT id
              FROM ko_print_job
             WHERE agent_id = %s
               AND state = 'queued'
             ORDER BY id ASC
             LIMIT %s
            FOR UPDATE SKIP LOCKED
            """,
            (agent.id, max_jobs),
        )
        job_ids = [row[0] for row in self.env.cr.fetchall()]
        if not job_ids:
            return self.browse()

        jobs = self.sudo().browse(job_ids)
        # Written through the ORM so write_date moves — _requeue_stuck reads it.
        for job in jobs:
            job.write({'state': 'sent', 'attempts': job.attempts + 1})
        return jobs

    def _to_agent_payload(self):
        """The wire format the shop agent consumes."""
        self.ensure_one()
        image = self.image
        if isinstance(image, bytes):
            image = image.decode('ascii')
        return {
            'id': self.id,
            'host': self.host or '',
            'port': self.port or 9100,
            'paper_width': int(self.paper_width or '80'),
            'image_png_b64': image or None,
            'cut': bool(self.cut),
            'open_cashdrawer': bool(self.open_cashdrawer),
            'origin': self.origin or '',
        }

    def _ack(self, status, error=None):
        self.ensure_one()
        if status == 'done':
            self.sudo().write({'state': 'done', 'error': False})
        else:
            self.sudo().write({'state': 'error', 'error': (error or 'unknown error')[:2000]})
        return True

    # ------------------------------------------------------------------
    # Housekeeping
    # ------------------------------------------------------------------

    @api.model
    def _gc_print_jobs(self, days=GC_DAYS):
        cutoff = fields.Datetime.subtract(fields.Datetime.now(), days=days)
        old = self.sudo().search([('create_date', '<', cutoff)])
        count = len(old)
        if count:
            old.unlink()
            _logger.info('ko_pos_cloud_print: removed %s print jobs older than %s days', count, days)
        return count
