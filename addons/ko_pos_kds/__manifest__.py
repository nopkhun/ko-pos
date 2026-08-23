# -*- coding: utf-8 -*-
{
    'name': 'KO Restaurant - Kitchen Display (KDS)',
    'version': '19.0.4.0.2',
    'category': 'Sales/Point of Sale',
    'summary': 'จอครัว (Kitchen Display System) สำหรับ Odoo Community',
    'description': """
Kitchen Display System for POS Restaurant (community edition):
- ทุกครั้งที่พนักงานกด "สั่งอาหาร" ใน POS ระบบจะสร้างตั๋วครัว (KDS ticket)
- เปิดจอครัวได้ที่ /kds ผ่าน browser บนแท็บเล็ต/จอใดก็ได้ (ต้อง login)
- แยกสถานี (station) ตามหมวดสินค้าได้ เช่น ครัวร้อน เครื่องดื่ม ของหวาน
- การ์ดออเดอร์: โต๊ะ, เวลา, รายการ + หมายเหตุ, สถานะ ใหม่/กำลังทำ/เสร็จ
- แจ้งเตือนเสียงเมื่อมีออเดอร์ใหม่
""",
    'author': 'KO',
    'license': 'LGPL-3',
    'depends': ['pos_restaurant', 'bus'],
    'data': [
        'security/ir.model.access.csv',
        'data/kds_data.xml',
        'views/kds_templates.xml',
        'views/kds_views.xml',
    ],
    'assets': {
        'web.assets_frontend': [
            'ko_pos_kds/static/src/kds/kds_bus.js',
        ],
        'point_of_sale._assets_pos': [
            'ko_pos_kds/static/src/pos/**/*',
        ],
        'point_of_sale.assets_prod': [
            'ko_pos_kds/static/src/pos/**/*',
        ],
    },
    'installable': True,
}
