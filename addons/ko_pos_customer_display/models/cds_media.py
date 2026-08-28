# -*- coding: utf-8 -*-
import mimetypes as std_mimetypes

from odoo import api, fields, models
from odoo.exceptions import ValidationError

# ไฟล์ที่จอลูกค้าเล่นได้จริงบน browser ทุกตัวที่ร้านใช้ — อย่างอื่นปฏิเสธตั้งแต่ตอนอัปโหลด
ALLOWED_IMAGE_MIMETYPES = {
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
}
ALLOWED_VIDEO_MIMETYPES = {
    'video/mp4', 'video/webm',
}
MAX_FILE_SIZE = 50 * 1024 * 1024  # 50 MB ต่อไฟล์ — กันวิดีโอใหญ่กินดิสก์ VPS


class KoCdsMedia(models.Model):
    _name = 'ko.cds.media'
    _description = 'สื่อโฆษณาจอลูกค้า (Customer Display Media)'
    _order = 'sequence, id'

    name = fields.Char(string='ชื่อสื่อ', compute='_compute_name', store=True, readonly=False)
    sequence = fields.Integer(string='ลำดับ', default=10)
    active = fields.Boolean(string='ใช้งาน', default=True)
    config_id = fields.Many2one(
        'pos.config', string='จุดขาย', required=True, index=True, ondelete='cascade',
        help='สื่อนี้เล่นบนจอลูกค้าของจุดขายไหน')
    company_id = fields.Many2one(
        related='config_id.company_id', store=True, index=True)
    media_file = fields.Binary(
        string='ไฟล์สื่อ', attachment=True, required=True,
        help='ภาพนิ่ง (JPG/PNG/WebP/GIF) หรือวิดีโอ (MP4 H.264/WebM ไม่เกิน 50 MB)\n'
             'ขนาดที่แนะนำ: จอแนวนอน/TV 1920 × 1080 px (16:9), '
             'จอแนวตั้ง/แท็บเล็ต 1080 × 1920 px (9:16)\n'
             'อัตราส่วนต้องตรงกับจอลูกค้าจริง ไม่งั้นสื่อจะถูกย่อให้พอดีจอและเหลือขอบดำ\n'
             'วิดีโอจะเล่นแบบไม่มีเสียงเสมอ — browser ไม่อนุญาตให้เล่นเสียงอัตโนมัติ')
    media_filename = fields.Char(string='ชื่อไฟล์')
    mimetype = fields.Char(
        string='ชนิดไฟล์', compute='_compute_mimetype', store=True)
    media_type = fields.Selection(
        selection=[('image', 'ภาพนิ่ง'), ('video', 'วิดีโอ')],
        string='ประเภท', compute='_compute_mimetype', store=True)
    duration_seconds = fields.Integer(
        string='แสดงนาน (วินาที)', default=0,
        help='เฉพาะภาพนิ่ง: 0 = ใช้ค่ากลางของจุดขาย ส่วนวิดีโอเล่นจนจบเสมอ')

    @api.depends('media_filename')
    def _compute_name(self):
        for media in self:
            if not media.name and media.media_filename:
                media.name = media.media_filename.rsplit('.', 1)[0]

    @api.depends('media_file', 'media_filename')
    def _compute_mimetype(self):
        for media in self:
            mimetype = media._detect_mimetype()
            media.mimetype = mimetype
            if mimetype in ALLOWED_VIDEO_MIMETYPES:
                media.media_type = 'video'
            elif mimetype in ALLOWED_IMAGE_MIMETYPES:
                media.media_type = 'image'
            else:
                media.media_type = False

    def _detect_mimetype(self):
        """Guess from the uploaded filename first: the ir.attachment behind a
        binary field is named after the *field*, so Odoo's content sniffing
        reports application/octet-stream for video files it does not know."""
        self.ensure_one()
        guessed = std_mimetypes.guess_type(self.media_filename or '')[0]
        if guessed:
            return guessed.lower()
        attachment = self._media_attachment()
        return (attachment.mimetype or '').lower()

    def _media_attachment(self):
        """The ir.attachment behind the binary field (empty recordset on new records)."""
        self.ensure_one()
        if not self.id:
            return self.env['ir.attachment']
        return self.env['ir.attachment'].sudo().search([
            ('res_model', '=', self._name),
            ('res_field', '=', 'media_file'),
            ('res_id', '=', self.id),
        ], limit=1)

    @api.constrains('media_file', 'media_filename')
    def _check_media_file(self):
        allowed = ALLOWED_IMAGE_MIMETYPES | ALLOWED_VIDEO_MIMETYPES
        for media in self:
            attachment = media._media_attachment()
            if not attachment:
                continue
            mimetype = media._detect_mimetype()
            if mimetype not in allowed:
                raise ValidationError(
                    'ไฟล์ "%s" ใช้ไม่ได้ (%s) — รองรับเฉพาะภาพ JPG/PNG/WebP/GIF '
                    'และวิดีโอ MP4/WebM' % (media.media_filename or media.name or '?',
                                            mimetype or 'ไม่ทราบชนิด'))
            if attachment.file_size > MAX_FILE_SIZE:
                raise ValidationError(
                    'ไฟล์ "%s" ใหญ่เกิน 50 MB (%.1f MB) — ย่อวิดีโอเป็น 1080p H.264 '
                    'ก่อนอัปโหลด จอลูกค้าไม่ต้องใช้ไฟล์ละเอียดกว่านั้น'
                    % (media.media_filename or media.name or '?',
                       attachment.file_size / (1024.0 * 1024.0)))

    def _playlist_entry(self):
        """One item of the customer display ad playlist, URL carries the POS access token."""
        self.ensure_one()
        attachment = self._media_attachment()
        version = attachment.checksum or (self.write_date and self.write_date.strftime('%Y%m%d%H%M%S')) or '0'
        return {
            'id': self.id,
            'type': self.media_type,
            'seconds': max(0, self.duration_seconds),
            'url': '/ko_cds/media/%s/%s?access_token=%s&v=%s' % (
                self.config_id.id, self.id, self.config_id.access_token, version),
        }
