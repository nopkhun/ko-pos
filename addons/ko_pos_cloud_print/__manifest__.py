# -*- coding: utf-8 -*-
{
    'name': 'KO Restaurant - Cloud Print Agent (พิมพ์ผ่านตัวแทน)',
    'version': '19.0.1.0.0',
    'category': 'Sales/Point of Sale',
    'summary': 'พิมพ์ใบเสร็จและใบครัวเงียบ ๆ ผ่านเครื่องพิมพ์ ESC/POS ในร้าน โดยที่ Odoo อยู่บนคลาวด์',
    'description': """
Silent thermal printing for a POS served over HTTPS from a cloud VPS.

The browser cannot reach a printer on the shop's LAN, so nothing here talks to a
printer. Instead:

- the POS renders the receipt to a canvas exactly the way Odoo core already does
  (BasePrinter.printReceipt) and POSTs the PNG to Odoo as a print job;

- a small Python agent on a PC in the shop polls Odoo for its jobs and pushes
  them to a generic ESC/POS network printer over raw TCP 9100;

- Odoo itself never opens a socket to a printer.

ภาษาไทย:

- ใบเสร็จลูกค้าและใบสั่งครัวพิมพ์อัตโนมัติ ไม่ต้องกดยืนยันหน้าเบราว์เซอร์

- ใช้ได้กับเบราว์เซอร์ทุกตัว (Windows Chrome, Android, Sunmi, iPad Safari)

- ถ้าตัวแทนพิมพ์ออฟไลน์ ระบบจะพิมพ์ผ่านเบราว์เซอร์ให้แทนโดยอัตโนมัติ

This module does not change the kitchen display in any way: KDS and kitchen
printers stay independent, exactly as AGENTS.md requires.
""",
    'author': 'KO',
    'license': 'LGPL-3',
    'depends': ['point_of_sale', 'pos_restaurant'],
    'data': [
        'security/ir.model.access.csv',
        'security/cloud_print_security.xml',
        'data/ir_cron.xml',
        'views/print_agent_views.xml',
        'views/print_job_views.xml',
        'views/pos_printer_views.xml',
        'views/res_config_settings_views.xml',
    ],
    'assets': {
        'point_of_sale._assets_pos': [
            'ko_pos_cloud_print/static/src/app/**/*',
        ],
    },
    'installable': True,
}
