# -*- coding: utf-8 -*-
{
    'name': 'KO Restaurant - Kitchen Display (KDS)',
    'version': '19.0.7.0.0',
    'category': 'Sales/Point of Sale',
    'summary': 'จอครัว (Kitchen Display System) สำหรับ Odoo Community',
    'description': """
Kitchen Display System for POS Restaurant (community edition):
- ออเดอร์เข้าครัวได้ 2 ทาง: กด "ส่งครัว" หลังคีย์ลงโต๊ะ/กลับบ้าน และส่งอัตโนมัติทันทีหลังชำระเงิน
- เปิดจอครัวได้ที่ /kds ผ่าน browser บนแท็บเล็ต/จอใดก็ได้ (ต้อง login)
- แยกจอตามร้าน: จอครัวหนึ่งเครื่องผูกกับจุดขาย (POS) เดียว ที่ /kds/pos/<id> ไม่ปนกับร้านอื่น
- แยกสถานีได้เอง (ครัวร้อน ครัวเย็น บาร์น้ำ ครัวขนม ฯลฯ) กำหนดได้ทั้งหมวดสินค้าและเมนูรายตัว
- การ์ดออเดอร์: โต๊ะ/ชื่อลูกค้า, เวลา, รายการ + หมายเหตุ, สถานะ ใหม่/กำลังทำ/เสร็จ
- แจ้งเตือนเสียงเมื่อมีรายการใหม่เข้าครัว (รวมถึงรายการที่เพิ่มเข้าออเดอร์เดิม)
- ครัวแจ้งปัญหากลับหน้าร้านได้ (ของหมด / ล่าช้า / ขอเปลี่ยน) พร้อมเสียงและแถบเตือนค้างจนกดรับทราบ
- คืนเงินแล้วจานที่คืนจะถูกยกเลิกบนจอครัวให้อัตโนมัติ คืนบางรายการก็ตัดเฉพาะจานนั้น
""",
    'author': 'KO',
    'license': 'LGPL-3',
    'depends': ['pos_restaurant', 'bus'],
    'data': [
        'security/ir.model.access.csv',
        'security/kds_security.xml',
        'data/kds_data.xml',
        'data/kds_migrate.xml',
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
