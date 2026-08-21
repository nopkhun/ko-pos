# -*- coding: utf-8 -*-
import logging
import os

from odoo import api, models

_logger = logging.getLogger(__name__)


class KoThaiLang(models.AbstractModel):
    _name = 'ko.thai.lang'
    _description = 'คำแปลไทยฉบับร้านอาหาร (ตัวโหลด override)'

    @api.model
    def _apply_overrides(self):
        """โหลดคำแปล override (model terms) เข้าฐานข้อมูลแบบ overwrite

        ถูกเรียกจาก data/apply_overrides.xml ทุกครั้งที่ติดตั้ง/อัปเกรด module นี้
        จึง re-apply ได้เสมอแม้ module อื่นเพิ่งถูกอัปเกรดและเขียนคำแปลมาตรฐานทับ
        """
        from odoo.tools.translate import TranslationImporter
        from odoo.addons.ko_pos_thai_lang import OVERRIDE_DIR

        lang = 'th_TH'
        if not self.env['res.lang'].search_count([('code', '=', lang)]):
            _logger.info("ko_pos_thai_lang: language %s not installed, skipping", lang)
            return

        importer = TranslationImporter(self.env.cr, verbose=False)
        files = 0
        for fn in sorted(os.listdir(OVERRIDE_DIR)):
            if fn.endswith('.po'):
                importer.load_file(os.path.join(OVERRIDE_DIR, fn), lang)
                files += 1
        importer.save(overwrite=True)
        _logger.info("ko_pos_thai_lang: applied Thai override translations from %s files", files)
