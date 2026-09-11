# -*- coding: utf-8 -*-
from odoo import api, fields, models


class PosConfig(models.Model):
    _inherit = 'pos.config'

    ko_receipt_printer_id = fields.Many2one(
        'pos.printer',
        string='Receipt Printer (KO Print Agent)',
        domain="[('printer_type', '=', 'ko_cloud')]",
        help='Customer receipts are printed silently on this printer through the '
             'shop print agent. Kitchen tickets keep using the preparation '
             'printers configured under Preparation.',
    )
    ko_cashdrawer = fields.Boolean(
        string='Open Cash Drawer',
        help='Send a drawer-kick pulse to the receipt printer when a receipt prints.',
    )

    @api.model
    def _load_pos_data_fields(self, config):
        """Expose the two KO fields to the POS client.

        Core returns an empty list for pos.config, and an empty list means
        "read every field" in `read()`. Appending to it would turn that into a
        two-field read and break the whole POS, so only extend a list that is
        already explicit.
        """
        fields_list = super()._load_pos_data_fields(config)
        if not fields_list:
            return fields_list
        return fields_list + ['ko_receipt_printer_id', 'ko_cashdrawer']


class ResConfigSettings(models.TransientModel):
    _inherit = 'res.config.settings'

    pos_ko_receipt_printer_id = fields.Many2one(
        related='pos_config_id.ko_receipt_printer_id', readonly=False)
    pos_ko_cashdrawer = fields.Boolean(
        related='pos_config_id.ko_cashdrawer', readonly=False)
