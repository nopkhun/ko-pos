# -*- coding: utf-8 -*-
{
    'name': 'KO Thai Language (คำแปลไทยฉบับร้านอาหาร)',
    'version': '19.0.1.1.0',
    'category': 'Localization',
    'summary': 'ปรับคำแปลภาษาไทยทั้งระบบให้เป็นภาษาที่ใช้จริงในร้านอาหาร อ่านง่าย ไม่สับสน',
    'description': """
คำแปลไทยฉบับร้านอาหาร
=====================
- แปลหน้าจอ POS / จอครัว / ใบเสร็จ ใหม่ทั้งหมดด้วยภาษาร้านอาหารจริง
  (ออเดอร์, บิล, ปิดรอบ, เงินทอน, สต็อก)
- กวาดแก้คำแปลสับสนทั่วทั้งระบบด้วยอภิธานศัพท์กลาง
- กลไก: ไฟล์ override ใน i18n_overrides/ ถูกโหลดทับคำแปลมาตรฐาน
  ทั้งในฐานข้อมูล (model terms) และข้อความจากโค้ด Python/JavaScript
""",
    'author': 'KO',
    'license': 'LGPL-3',
    'depends': [
        'point_of_sale',
        'pos_restaurant',
        'pos_hr',
        'pos_self_order',
        'ko_pos_setup',
        'ko_pos_kds',
        'ko_pos_thai_receipt',
        'ko_pos_beam_bolt',
    ],
    'data': [
        'data/apply_overrides.xml',
    ],
    'installable': True,
}
