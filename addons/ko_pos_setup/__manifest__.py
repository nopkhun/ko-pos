# -*- coding: utf-8 -*-
{
    'name': 'KO Restaurant - Setup',
    'version': '1.0.1',
    'category': 'Sales/Point of Sale',
    'summary': 'ตั้งค่าเริ่มต้นร้านอาหาร KO: ผังโต๊ะ เมนู สต็อกวัตถุดิบ วิธีชำระเงิน ข้อมูลบริษัท',
    'description': """
Base configuration for KO Restaurant POS:
- Restaurant floors & tables (แก้ไขได้ในหน้าตั้งค่า)
- POS categories + sample Thai menu (แทนที่ด้วยเมนูจริงได้)
- Ingredient products + BoM (kit) examples for automatic stock deduction
- Payment methods: Cash / PromptPay QR (EMV)
- Kitchen order printer placeholder (Epson ePOS)
- Company info setup
""",
    'author': 'KO',
    'license': 'LGPL-3',
    'depends': [
        'point_of_sale',
        'pos_restaurant',
        'pos_hr',
        'mrp',
        'purchase',
        'l10n_th',
        'account_qr_code_emv',
    ],
    'data': [
        'data/company_data.xml',
        'data/pos_category_data.xml',
        'data/restaurant_data.xml',
        'data/product_data.xml',
    ],
    'post_init_hook': 'post_init_hook',
    'installable': True,
}
