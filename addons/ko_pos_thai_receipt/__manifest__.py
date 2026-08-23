# -*- coding: utf-8 -*-
{
    'name': 'KO Restaurant - Thai Receipt (ใบกำกับภาษีอย่างย่อ)',
    'version': '1.0.0',
    'category': 'Sales/Point of Sale',
    'summary': 'ใบเสร็จ/ใบกำกับภาษีอย่างย่อ ภาษาไทย พร้อมข้อมูลผู้เสียภาษีและเลขรหัสประจำเครื่อง POS',
    'description': """
Thai abbreviated tax invoice (ใบกำกับภาษีอย่างย่อ) layout for POS receipts:
- ชื่อร้าน ที่อยู่ เลขประจำตัวผู้เสียภาษี
- หัวใบเสร็จ "ใบกำกับภาษีอย่างย่อ (TAX INVOICE ABB)"
- เลขรหัสประจำเครื่อง POS (ตามที่จดทะเบียนกับกรมสรรพากร)
- ข้อความ "ราคารวมภาษีมูลค่าเพิ่มแล้ว"
""",
    'author': 'KO',
    'license': 'LGPL-3',
    'depends': ['point_of_sale'],
    'data': [
        'views/pos_config_views.xml',
    ],
    'assets': {
        'point_of_sale._assets_pos': [
            'ko_pos_thai_receipt/static/src/**/*',
        ],
    },
    'installable': True,
}
