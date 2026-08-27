# -*- coding: utf-8 -*-
{
    'name': 'KO POS - Customer Display (จอลูกค้า)',
    'version': '19.0.1.0.0',
    'category': 'Sales/Point of Sale',
    'summary': 'จอที่ 2 สำหรับลูกค้า: รายการออเดอร์สด, QR ชำระเงิน และสื่อโฆษณาเมื่อจอว่าง',
    'description': """
จอลูกค้า (Customer Display) สำหรับร้านอาหาร:
- ต่อยอดจอลูกค้าในตัวของ Odoo: เปิดจากเมนู POS ได้ทั้งบนเครื่องเดียวกันและอุปกรณ์อื่น
  (สแกน QR ลิงก์ เปิดบนแท็บเล็ต/จอไหนก็ได้ ไม่ต้อง login)
- แสดงรายการออเดอร์สด ๆ ตามที่พนักงานคีย์: ชื่อเมนู จำนวน ราคา ส่วนลด หมายเหตุลูกค้า
  ยอดรวม เงินทอน เป็นภาษาไทยทั้งหมด
- จอว่างเกินเวลาที่ตั้ง จะเล่นสื่อโฆษณาอัตโนมัติ (ภาพนิ่ง + วิดีโอ) วนตามลำดับ
  มีออเดอร์เข้าเมื่อไหร่ตัดกลับหน้าออเดอร์ทันที
- Layout ปรับตามอุปกรณ์อัตโนมัติ: มือถือ/แท็บเล็ตแนวตั้ง แนวนอน หรือจอ TV
- รองรับ QR ชำระเงินบนจอลูกค้า (ผ่านช่องทางที่ตั้งค่าใน payment method)
""",
    'author': 'KO',
    'license': 'LGPL-3',
    'depends': ['point_of_sale'],
    'data': [
        'security/ir.model.access.csv',
        'views/cds_views.xml',
    ],
    'assets': {
        'point_of_sale.customer_display_assets': [
            'ko_pos_customer_display/static/src/customer_display/**/*',
        ],
        'point_of_sale._assets_pos': [
            'ko_pos_customer_display/static/src/pos/**/*',
        ],
        'point_of_sale.assets_prod': [
            'ko_pos_customer_display/static/src/pos/**/*',
        ],
    },
    'installable': True,
    'application': False,
}
