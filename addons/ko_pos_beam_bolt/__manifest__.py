# -*- coding: utf-8 -*-
{
    'name': 'KO Restaurant - Beam Bolt+ Payment Terminal',
    'version': '19.0.2.0.1',
    'category': 'Sales/Point of Sale',
    'summary': 'เชื่อม POS กับเครื่องชำระเงิน Beam Bolt+ (Pairing Mode)',
    'description': """
Beam Bolt+ payment terminal integration for Odoo POS
====================================================
- ส่งยอดจากหน้าจ่ายเงิน POS ไปเครื่อง Bolt+ อัตโนมัติ (Bolt Intent, Pairing Mode)
- Pair / ตรวจสอบ / ยกเลิกการเชื่อมต่อเครื่องด้วยรหัสจากเครื่องหรือแอป Beam Bolt
- รองรับวิธีชำระเงินทุกประเภทใน Bolt Intent API v1 รวมถึงบัตรผ่อนชำระ
- Poll สถานะจนชำระสำเร็จ / ยกเลิก / หมดเวลา
- ใช้ idempotency key ป้องกันการสร้างรายการซ้ำเมื่อเครือข่ายสะดุด
- รองรับ Playground (sandbox) ของ Beam สำหรับทดสอบ

การตั้งค่า: Point of Sale > Configuration > Payment Methods
สร้างวิธีชำระเงินใหม่ เลือก "ใช้เครื่องชำระเงิน" = Beam Bolt+
กรอก Merchant ID และ API Key จาก Beam Lighthouse จากนั้นกรอกรหัส Pairing
ที่แสดงบนเครื่องหรือแอป Beam Bolt แล้วกด "เชื่อมต่อเครื่อง"
""",
    'author': 'KO',
    'license': 'LGPL-3',
    'depends': ['point_of_sale'],
    'data': [
        'views/pos_payment_method_views.xml',
    ],
    'assets': {
        'point_of_sale._assets_pos': [
            'ko_pos_beam_bolt/static/src/**/*',
        ],
    },
    'installable': True,
}
