# -*- coding: utf-8 -*-
from odoo import http
from odoo.http import request
from odoo.tools import consteq


class KoCdsController(http.Controller):
    """Serve customer display ad media to the (public) display page.

    The display page itself is Odoo's /pos_customer_display/<id>/<uuid> route,
    authenticated by the pos.config access token. Media URLs carry the same
    token, so a screen that may open the display may also load its media —
    and nothing else can.
    """

    @http.route('/ko_cds/media/<int:config_id>/<int:media_id>',
                auth='public', type='http', methods=['GET'])
    def cds_media(self, config_id, media_id, access_token='', **kw):
        config = request.env['pos.config'].sudo().browse(config_id).exists()
        if not config or not access_token or not consteq(access_token, config.access_token or ''):
            return request.not_found()
        media = request.env['ko.cds.media'].sudo().browse(media_id).exists()
        if not media or media.config_id.id != config.id:
            return request.not_found()
        # ส่ง mimetype ที่ตรวจจากชื่อไฟล์ไปด้วย — attachment ของ binary field
        # ถูกเดาเป็น octet-stream สำหรับวิดีโอ ซึ่ง Safari ไม่ยอมเล่น
        stream = request.env['ir.binary']._get_stream_from(
            media, 'media_file', filename=media.media_filename or media.name,
            mimetype=media.mimetype or None)
        # URL มี checksum (&v=) อยู่แล้ว — cache ยาวได้ ไฟล์เปลี่ยนเมื่อไหร่ URL เปลี่ยนเอง
        return stream.get_response(max_age=86400)
