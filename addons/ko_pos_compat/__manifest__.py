# -*- coding: utf-8 -*-
{
    'name': 'KO POS - Old Browser Compatibility (รองรับเบราว์เซอร์เก่า)',
    'version': '19.0.1.1.0',
    'category': 'Technical',
    'summary': 'เติม JavaScript built-in ที่ Odoo 19 เรียกใช้ แต่ Chrome/WebView เก่า (เช่นบน Android 7) ไม่มี',
    'description': """
Odoo 19 core เรียก built-in ใหม่ ๆ ที่ Chromium เก่าไม่มี พอเรียกแล้วทั้งหน้าตายด้วย
`TypeError: ... is not a function` โมดูลนี้เติมให้ครบก่อนโค้ดอื่นทำงาน:

- Object.groupBy / Map.groupBy (Chrome 117) — chatter และ analytic search
- Array#toSorted / toReversed / toSpliced / with (110) — **เครื่องคิดภาษีของ POS**
- Array#findLast / findLastIndex (97)
- Promise.withResolvers (119)
- URL.canParse (120) / URL.parse (126) — เครื่องมือแทรกลิงก์กับวิดีโอ
- AbortSignal.timeout (103) / AbortSignal.any (116) — เส้นทางคุยกับ IoT box
  (เครื่องพิมพ์ครัว / ลิ้นชักเงิน)
- Set#union / intersection / difference / symmetricDifference /
  isSubsetOf / isSupersetOf / isDisjointFrom (122) — ไฮไลต์ในมุมมองปฏิทิน

ฝั่ง CSS: static/src/ko_css_compat.scss เติม fallback หน่วย vh ให้กฎที่ core เขียน
ด้วย dvh (Chrome 108+) โดยไม่มี fallback — bottom sheet และ modal ของ POS

**สิ่งที่โมดูลนี้ทำให้ไม่ได้:** bundle ของ Odoo 19 ต้องใช้ ES2022 syntax เบราว์เซอร์
ที่เก่ากว่า Chrome 94 จะพังตั้งแต่ขั้น parse ไม่มีทางแก้ด้วย polyfill
ส่วน CSS :has() ที่ core ใช้ (Chrome 105+) เติมให้ไม่ได้ แต่ตรวจแล้วว่ากระทบ POS
แค่ 6 กฎและเป็นเรื่องความสวยงามล้วน ๆ อ่าน docs/GOTCHAS.md ประกอบ

ไฟล์อยู่ใน static/lib/ โดยตั้งใจ — ไฟล์ใน static/lib จะไม่ถูกห่อเป็น Odoo module
จึงรันทันทีตอนโหลด bundle คือก่อนที่ module loader จะเริ่มรันโมดูลใด ๆ
""",
    'author': 'KO',
    'license': 'LGPL-3',
    'depends': ['web', 'point_of_sale'],
    'assets': {
        # JS ต้อง prepend — ให้ polyfill อยู่หน้าสุด ก่อนโค้ดอื่นทุกบรรทัด
        # SCSS ต้อง append (ลิสต์ปกติ) — ต้องมาทีหลัง core ถึงจะทับกฎ dvh ที่มี var() ได้
        'web.assets_web': [
            ('prepend', 'ko_pos_compat/static/lib/ko_es_compat.js'),
            'ko_pos_compat/static/src/ko_css_compat.scss',
        ],
        'web.assets_frontend': [
            ('prepend', 'ko_pos_compat/static/lib/ko_es_compat.js'),
            'ko_pos_compat/static/src/ko_css_compat.scss',
        ],
        # _assets_pos เป็นฐานที่ถูก include เข้าทั้ง assets_prod และก้อน debug
        # จึงใส่ที่นี่ที่เดียว ไม่ต้องใส่ assets_prod ซ้ำ
        'point_of_sale._assets_pos': [
            ('prepend', 'ko_pos_compat/static/lib/ko_es_compat.js'),
            'ko_pos_compat/static/src/ko_css_compat.scss',
        ],
        # จอลูกค้าไม่มี bottom sheet และไม่มี modal ของ POS จึงเอาเฉพาะ JS
        'point_of_sale.customer_display_assets': [
            ('prepend', 'ko_pos_compat/static/lib/ko_es_compat.js'),
        ],
    },
    'installable': True,
    'application': False,
    'auto_install': True,
}
