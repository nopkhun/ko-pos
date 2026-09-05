# -*- coding: utf-8 -*-
{
    'name': 'KO POS - Old Browser Compatibility (รองรับเบราว์เซอร์เก่า)',
    'version': '19.0.1.0.0',
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

**สิ่งที่โมดูลนี้ทำให้ไม่ได้:** bundle ของ Odoo 19 ต้องใช้ ES2022 syntax และ CSS
`:has()` เบราว์เซอร์ที่เก่ากว่า Chrome 94 จะพังตั้งแต่ขั้น parse และที่เก่ากว่า
Chrome 111 สีจาก oklch() จะเพี้ยน อ่าน docs/GOTCHAS.md ประกอบก่อนตั้งความหวัง

ไฟล์อยู่ใน static/lib/ โดยตั้งใจ — ไฟล์ใน static/lib จะไม่ถูกห่อเป็น Odoo module
จึงรันทันทีตอนโหลด bundle คือก่อนที่ module loader จะเริ่มรันโมดูลใด ๆ
""",
    'author': 'KO',
    'license': 'LGPL-3',
    'depends': ['web', 'point_of_sale'],
    'assets': {
        # prepend ทุกก้อน เพื่อให้ polyfill อยู่หน้าสุดเสมอ
        'web.assets_web': [
            ('prepend', 'ko_pos_compat/static/lib/ko_es_compat.js'),
        ],
        'web.assets_frontend': [
            ('prepend', 'ko_pos_compat/static/lib/ko_es_compat.js'),
        ],
        # _assets_pos เป็นฐานที่ถูก include เข้าทั้ง assets_prod และก้อน debug
        # จึงใส่ที่นี่ที่เดียว ไม่ต้องใส่ assets_prod ซ้ำ
        'point_of_sale._assets_pos': [
            ('prepend', 'ko_pos_compat/static/lib/ko_es_compat.js'),
        ],
        'point_of_sale.customer_display_assets': [
            ('prepend', 'ko_pos_compat/static/lib/ko_es_compat.js'),
        ],
    },
    'installable': True,
    'application': False,
    'auto_install': True,
}
