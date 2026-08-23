# -*- coding: utf-8 -*-
{
    'name': 'KO Restaurant - Beam Bolt+ Payment Terminal',
    'version': '1.0.0',
    'category': 'Sales/Point of Sale',
    'summary': 'เชื่อม POS กับเครื่องชำระเงิน Beam Bolt+ (Pairing Mode)',
    'description': """
Beam Bolt+ payment terminal integration for Odoo POS
====================================================
- ส่งยอดจากหน้าจ่ายเงิน POS ไปเครื่อง Bolt+ อัตโนมัติ (Bolt Intent, Pairing Mode)
- รองรับ บัตรเครดิต/เดบิต, QR PromptPay, TrueMoney, Alipay, WeChat Pay ฯลฯ
- Poll สถานะจนชำระสำเร็จ / ยกเลิก / หมดเวลา
- รองรับ Playground (sandbox) ของ Beam สำหรับทดสอบ

การตั้งค่า: Point of Sale > Configuration > Payment Methods
สร้างวิธีชำระเงินใหม่ เลือก "ใช้เครื่องชำระเงิน" = Beam Bolt+
กรอก Merchant ID, API Key และ Bolt Connection ID (จากการ pair เครื่องใน Beam dashboard)
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
