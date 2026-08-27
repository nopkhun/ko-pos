# -*- coding: utf-8 -*-
from odoo import fields, models


class PosConfig(models.Model):
    _inherit = 'pos.config'

    ko_cds_media_ids = fields.One2many(
        'ko.cds.media', 'config_id', string='สื่อโฆษณาจอลูกค้า')
    ko_cds_idle_seconds = fields.Integer(
        string='เริ่มเล่นโฆษณาหลังจอว่าง (วินาที)', default=15,
        help='จอลูกค้าไม่มีออเดอร์ค้างนานเท่านี้ จึงเริ่มเล่นสื่อโฆษณา')
    ko_cds_image_seconds = fields.Integer(
        string='ภาพนิ่งแสดงภาพละ (วินาที)', default=8,
        help='ค่ากลางของภาพนิ่งทุกภาพ ยกเว้นภาพที่ตั้งเวลาเฉพาะตัวไว้ '
             'ส่วนวิดีโอเล่นจนจบเสมอ')

    def _get_customer_display_data(self):
        data = super()._get_customer_display_data()
        media = self.env['ko.cds.media'].sudo().search([('config_id', '=', self.id)])
        data['ko_cds'] = {
            'shop_name': self.display_name,
            'idle_seconds': max(3, self.ko_cds_idle_seconds or 15),
            'image_seconds': max(2, self.ko_cds_image_seconds or 8),
            'playlist': [
                entry for entry in (m._playlist_entry() for m in media)
                if entry['type']  # ข้ามไฟล์ชนิดที่จอเล่นไม่ได้ แทนที่จะค้างจอดำ
            ],
        }
        return data
