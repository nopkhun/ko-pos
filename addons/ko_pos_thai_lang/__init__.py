# -*- coding: utf-8 -*-
import logging
import os

from . import models

_logger = logging.getLogger(__name__)

OVERRIDE_DIR = os.path.join(os.path.dirname(__file__), 'i18n_overrides')


def _load_override_code_terms(module_name, comment_marker):
    """อ่านคำแปล override ชนิด code (Python/JS) ของ module ที่กำหนดจากไฟล์ po ของเรา"""
    from odoo.tools.translate import translation_file_reader
    path = os.path.join(OVERRIDE_DIR, '%s.po' % module_name)
    if not os.path.isfile(path):
        return {}
    translations = {}
    with open(path, 'rb') as fileobj:
        for row in translation_file_reader(fileobj, fileformat='po'):
            if row.get('type') == 'code' and row.get('src') and row.get('value') \
                    and comment_marker in row.get('comments', ''):
                translations[row['src']] = row['value']
    return translations


def _patch_code_translations():
    """แทรกคำแปล override เข้าไปใน cache ของ CodeTranslations (ข้อความจากโค้ด Python/JS)

    Odoo 16+ ไม่เก็บคำแปลจากโค้ดในฐานข้อมูลแล้ว แต่อ่านจากไฟล์ po ของ module
    โดยตรง (ซึ่งอยู่ใน dist-packages แก้ไขไม่ได้) จึงต้อง wrap ตัวโหลดให้ merge
    คำแปลของเราทับ — ถ้าพลาดจะ fallback เป็นคำแปลเดิม ไม่ทำให้ระบบล่ม
    """
    from odoo.tools.misc import ReadonlyDict
    from odoo.tools.translate import (
        CodeTranslations,
        JAVASCRIPT_TRANSLATION_COMMENT,
        PYTHON_TRANSLATION_COMMENT,
        code_translations,
    )

    if getattr(CodeTranslations, '_ko_thai_patched', False):
        return

    orig_load_python = CodeTranslations._load_python_translations
    orig_load_web = CodeTranslations._load_web_translations

    def _load_python_translations(self, module_name, lang):
        orig_load_python(self, module_name, lang)
        if not lang.startswith('th'):
            return
        try:
            overrides = _load_override_code_terms(module_name, PYTHON_TRANSLATION_COMMENT)
            if overrides:
                merged = dict(self.python_translations[(module_name, lang)])
                merged.update(overrides)
                self.python_translations[(module_name, lang)] = ReadonlyDict(merged)
        except Exception:
            _logger.exception("ko_pos_thai_lang: python override failed for %s", module_name)

    def _load_web_translations(self, module_name, lang):
        orig_load_web(self, module_name, lang)
        if not lang.startswith('th'):
            return
        try:
            overrides = _load_override_code_terms(module_name, JAVASCRIPT_TRANSLATION_COMMENT)
            if overrides:
                current = self.web_translations[(module_name, lang)]
                merged = {m["id"]: m["string"] for m in current["messages"]}
                merged.update(overrides)
                self.web_translations[(module_name, lang)] = ReadonlyDict({
                    "messages": tuple(
                        ReadonlyDict({"id": src, "string": value})
                        for src, value in merged.items()
                    )
                })
        except Exception:
            _logger.exception("ko_pos_thai_lang: web override failed for %s", module_name)

    CodeTranslations._load_python_translations = _load_python_translations
    CodeTranslations._load_web_translations = _load_web_translations
    CodeTranslations._ko_thai_patched = True

    # ล้าง cache ภาษาไทยที่ถูกโหลดไปก่อน module นี้ถูก import
    for key in [k for k in list(code_translations.python_translations) if k[1].startswith('th')]:
        del code_translations.python_translations[key]
    for key in [k for k in list(code_translations.web_translations) if k[1].startswith('th')]:
        del code_translations.web_translations[key]


try:
    _patch_code_translations()
except Exception:  # pragma: no cover - ห้ามทำให้ Odoo boot ไม่ขึ้น
    _logger.exception("ko_pos_thai_lang: failed to patch code translations")
