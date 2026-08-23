# -*- coding: utf-8 -*-
{
    'name': 'KO Thai Language (คำแปลไทยฉบับร้านอาหาร)',
    'version': '19.0.1.1.0',
    'category': 'Localization',
    'summary': 'ปรับคำแปลภาษาไทยทั้งระบบให้เป็นภาษาที่ใช้จริงในร้านอาหาร อ่านง่าย ไม่สับสน',
    'description': """
คำแปลภาษาไทยฉบับร้านอาหารสำหรับ Odoo 19:
- แทนที่คำแปล stock Thai ที่ไม่เหมาะกับบริบท POS ร้านอาหาร
- เช่น "ลงบัญชีแล้ว" แทน "โพสต์", "บัตรเครดิต" แทน "การ์ด", "รอบขาย" แทน "เซสชั่น"
- โหลดอัตโนมัติเมื่อติดตั้งหรืออัปเกรด
""",
    'author': 'KO',
    'license': 'LGPL-3',
    'depends': [
        'base',
        'point_of_sale',
        'pos_restaurant',
        'account',
        'ko_pos_setup',
        'ko_pos_thai_receipt',
        'ko_pos_kds',
        'ko_pos_beam_bolt',
    ],
    'data': [
        'data/apply_overrides.xml',
    ],
    'installable': True,
    'auto_install': False,
}
