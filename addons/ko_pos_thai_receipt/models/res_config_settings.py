# -*- coding: utf-8 -*-
from odoo import fields, models


class ResConfigSettings(models.TransientModel):
    _inherit = 'res.config.settings'

    pos_rd_machine_no = fields.Char(
        related='pos_config_id.rd_machine_no', readonly=False)
    pos_thai_receipt_enabled = fields.Boolean(
        related='pos_config_id.thai_receipt_enabled', readonly=False)
