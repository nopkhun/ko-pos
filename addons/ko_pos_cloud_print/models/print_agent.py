# -*- coding: utf-8 -*-
import hmac
import secrets

from odoo import api, fields, models

# How long after its last ping an agent still counts as online. The agent is
# expected to poll roughly every 2 s, so 20 s tolerates a few missed polls
# without letting a dead agent swallow receipts.
ONLINE_WINDOW_SECONDS = 20


def generate_token():
    """A URL-safe token the shop agent sends back as `Authorization: Bearer ...`."""
    return secrets.token_urlsafe(32)


class KoPrintAgent(models.Model):
    _name = 'ko.print.agent'
    _description = 'KO Print Agent'
    _order = 'name, id'

    name = fields.Char(string='Agent Name', required=True)
    # Readable by POS managers only: it is a bearer credential. Every server-side
    # lookup goes through sudo(), so hiding it from cashiers costs nothing.
    token = fields.Char(
        string='Token',
        required=True,
        copy=False,
        default=lambda self: generate_token(),
        groups='point_of_sale.group_pos_manager',
        help='Paste this into the shop agent configuration. Treat it as a password.',
    )
    last_seen = fields.Datetime(string='Last Seen', readonly=True, copy=False)
    last_ip = fields.Char(string='Last IP Address', readonly=True, copy=False)
    agent_version = fields.Char(string='Agent Version', readonly=True, copy=False)
    company_id = fields.Many2one(
        'res.company', string='Company', required=True,
        default=lambda self: self.env.company, index=True,
    )
    active = fields.Boolean(string='Active', default=True)
    is_online = fields.Boolean(string='Online', compute='_compute_is_online')
    job_count = fields.Integer(string='Queued Jobs', compute='_compute_job_count')

    _token_unique = models.Constraint('unique (token)', 'Two print agents cannot share one token.')

    @api.depends('last_seen')
    def _compute_is_online(self):
        now = fields.Datetime.now()
        for agent in self:
            agent.is_online = bool(
                agent.last_seen
                and (now - agent.last_seen).total_seconds() <= ONLINE_WINDOW_SECONDS
            )

    def _compute_job_count(self):
        counts = dict(self.env['ko.print.job']._read_group(
            [('agent_id', 'in', self.ids), ('state', '=', 'queued')],
            groupby=['agent_id'], aggregates=['__count'],
        ))
        for agent in self:
            agent.job_count = counts.get(agent, 0)

    def action_regenerate_token(self):
        """Issue a fresh token. The shop agent has to be reconfigured afterwards."""
        for agent in self:
            agent.token = generate_token()
        return True

    def action_view_jobs(self):
        self.ensure_one()
        action = self.env['ir.actions.act_window']._for_xml_id('ko_pos_cloud_print.action_ko_print_job')
        action['domain'] = [('agent_id', '=', self.id)]
        action['context'] = {'default_agent_id': self.id}
        return action

    # ------------------------------------------------------------------
    # Used by the agent controllers
    # ------------------------------------------------------------------

    @api.model
    def _find_by_token(self, token):
        """Resolve a bearer token to an active agent, in constant time per agent.

        Searching on the token column directly would be simpler, but comparing
        with `hmac.compare_digest` keeps the check free of the early-exit timing
        that a plain `==` (or an indexed lookup) leaks. There are only ever a
        handful of agents, so the scan is cheap.
        """
        if not token or not isinstance(token, str):
            return self.browse()
        agents = self.sudo().search([])
        for agent in agents:
            if agent.token and hmac.compare_digest(agent.token, token):
                return agent
        return self.browse()

    def _touch(self, ip=None, agent_version=None):
        """Record that we just heard from this agent."""
        self.ensure_one()
        vals = {'last_seen': fields.Datetime.now()}
        if ip:
            vals['last_ip'] = ip
        if agent_version:
            vals['agent_version'] = str(agent_version)[:64]
        self.sudo().write(vals)
