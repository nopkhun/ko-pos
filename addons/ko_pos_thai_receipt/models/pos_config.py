# -*- coding: utf-8 -*-
from odoo import fields, models


class PosConfig(models.Model):
    _inherit = 'pos.config'

    rd_machine_no = fields.Char(
        string='เลขรหัสประจำเครื่อง POS',
        help='เลขรหัสประจำเครื่องบันทึกการเก็บเงินที่ได้รับอนุมัติจากกรมสรรพากร '
             '(แสดงบนใบกำกับภาษีอย่างย่อ)',
    )
    thai_receipt_enabled = fields.Boolean(
        string='ใช้รูปแบบใบกำกับภาษีอย่างย่อ',
        default=True,
        help='แสดงหัวใบเสร็จแบบใบกำกับภาษีอย่างย่อ (TAX INVOICE ABB)',
    )
