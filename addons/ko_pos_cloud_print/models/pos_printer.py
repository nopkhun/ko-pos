# -*- coding: utf-8 -*-
from odoo import _, api, fields, models
from odoo.exceptions import ValidationError
from odoo.fields import Domain

from .print_job import PAPER_WIDTHS


class PosPrinter(models.Model):
    _inherit = 'pos.printer'

    printer_type = fields.Selection(
        selection_add=[('ko_cloud', 'KO Print Agent (ESC/POS over network)')],
        ondelete={'ko_cloud': 'set default'},
    )
    ko_agent_id = fields.Many2one(
        'ko.print.agent', string='Print Agent',
        check_company=True,
        help='The PC in the shop that will actually talk to this printer.',
    )
    ko_host = fields.Char(
        string='Printer IP / Host',
        help='Address of the ESC/POS printer on the shop network, e.g. 192.168.1.50.',
    )
    ko_port = fields.Integer(string='Printer Port', default=9100)
    ko_paper_width = fields.Selection(PAPER_WIDTHS, string='Paper Width', default='80')

    @api.constrains('printer_type', 'ko_agent_id', 'ko_host', 'company_id')
    def _check_ko_cloud_settings(self):
        for printer in self:
            if printer.printer_type != 'ko_cloud':
                continue
            if not printer.ko_agent_id:
                raise ValidationError(_('Choose a print agent for "%s".', printer.name))
            if not printer.ko_host:
                raise ValidationError(_('Enter the printer IP address for "%s".', printer.name))
        # `check_company=True` only narrows the dropdown in the UI; pos.printer
        # does not set _check_company_auto, so nothing would stop one company's
        # printer being pointed at another company's agent through the ORM.
        self._check_company(['ko_agent_id'])

    @api.model
    def _load_pos_data_fields(self, config):
        return super()._load_pos_data_fields(config) + [
            'ko_agent_id', 'ko_host', 'ko_port', 'ko_paper_width',
        ]

    @api.model
    def _load_pos_data_domain(self, data, config):
        """Also load the customer receipt printer.

        Core only loads the preparation printers of `config.printer_ids`. The KO
        receipt printer is usually *not* one of them (it prints bills, not
        kitchen tickets), and if it is not loaded the POS cannot resolve
        `config.ko_receipt_printer_id` to a record at all.
        """
        domain = super()._load_pos_data_domain(data, config)
        if domain is False or not config.ko_receipt_printer_id:
            return domain
        # OR it onto whatever core (or another module) decided, rather than
        # replacing that domain and quietly dropping the preparation printers.
        return Domain.OR([
            Domain(domain),
            Domain('id', '=', config.ko_receipt_printer_id.id),
        ])
