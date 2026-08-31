# -*- coding: utf-8 -*-
import logging
from datetime import timedelta

from odoo import api, fields, models

_logger = logging.getLogger(__name__)

# Beam ปิดสถานะเองหลังหมดอายุ — เผื่อเวลาก่อน cron จะเริ่มตามแถวที่ค้าง
CRON_EXPIRY_GRACE_MINUTES = 5
# แถวที่ตามสถานะไม่ได้เกินอายุนี้ ให้เลิก poll แล้วขึ้นรายงานรอคนเคลียร์แทน
CRON_GIVE_UP_DAYS = 2

FINAL_STATUSES = ('SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELED', 'VOIDED')


class KoBeamQrCharge(models.Model):
    """สมุดบันทึกทุก charge ที่ POS สร้างผ่าน Beam Charges API

    Beam ไม่มี API ยกเลิก charge — QR เก่าสแกนได้จนหมดอายุ สมุดนี้ทำให้
    "เงินเข้าแต่ไม่ถูกผูกกับบิล" โผล่ในรายงานก่อนปิดรอบ แทนที่จะไปเจอทีหลัง
    ใน Lighthouse
    """
    _name = 'ko.beam.qr.charge'
    _description = 'Beam QR charge ledger'
    _order = 'create_date desc'
    _rec_name = 'charge_id'

    payment_method_id = fields.Many2one(
        'pos.payment.method', string='ช่องทางชำระเงิน',
        required=True, ondelete='restrict', index=True)
    charge_id = fields.Char(string='Beam Charge ID', required=True, index=True)
    reference_id = fields.Char(string='อ้างอิงบิล (referenceId)', index=True)
    amount_thb = fields.Float(string='ยอด (บาท)')
    status = fields.Selection(
        [
            ('PENDING', 'รอลูกค้าสแกน'),
            ('SUCCEEDED', 'เงินเข้าแล้ว'),
            ('FAILED', 'ไม่สำเร็จ'),
            ('EXPIRED', 'หมดอายุ'),
            ('CANCELED', 'ถูกยกเลิก'),
            ('VOIDED', 'ถูก Void'),
            ('UNKNOWN', 'ตามสถานะไม่ได้'),
        ],
        default='PENDING', required=True, index=True, string='สถานะจาก Beam')
    expiry_time = fields.Datetime(string='QR หมดอายุ (UTC)')
    pos_cancelled = fields.Boolean(
        string='พนักงานกดยกเลิกที่หน้าร้าน',
        help='True เมื่อพนักงานยกเลิกรายการนี้จาก POS — ถ้าสถานะกลายเป็น '
             '"เงินเข้าแล้ว" ภายหลัง แปลว่าลูกค้าสแกน QR ที่ถูกยกเลิกไปแล้ว')
    manual_ref = fields.Char(
        string='เลขอ้างอิงยืนยัน Manual',
        help='พนักงานยืนยันเองว่าลูกค้าโอนแล้ว (ช่วง Beam API มีปัญหา) — '
             'ต้องกระทบยอดกับ Lighthouse ตอนปิดรอบ')
    needs_review = fields.Boolean(
        string='ต้องตรวจสอบก่อนปิดรอบ',
        compute='_compute_needs_review', search='_search_needs_review')

    _sql_constraints = [
        ('charge_id_unique', 'unique(charge_id)', 'Charge ID ต้องไม่ซ้ำ'),
    ]

    # ------------------------------------------------------------------
    # needs_review: เงินเข้าแต่ไม่ถูกผูกกับบิล หรือค้างสถานะจนเลิก poll แล้ว
    # ------------------------------------------------------------------
    def _matched_charge_ids(self):
        """charge_id ที่มี pos.payment บันทึกไว้แล้ว (ปิดบิลอัตโนมัติ)"""
        charge_ids = [c for c in self.mapped('charge_id') if c]
        if not charge_ids:
            return set()
        payments = self.env['pos.payment'].sudo().search(
            [('transaction_id', 'in', charge_ids)])
        return set(payments.mapped('transaction_id'))

    @api.depends('status', 'manual_ref')
    def _compute_needs_review(self):
        matched = self._matched_charge_ids()
        give_up = fields.Datetime.now() - timedelta(days=CRON_GIVE_UP_DAYS)
        for record in self:
            if record.status == 'SUCCEEDED':
                record.needs_review = (
                    record.charge_id not in matched and not record.manual_ref)
            elif record.status in FINAL_STATUSES:
                record.needs_review = False
            else:
                # PENDING/UNKNOWN ที่เก่าจน cron เลิกตามแล้ว — ให้คนเช็ค Lighthouse
                record.needs_review = bool(
                    record.create_date and record.create_date < give_up)

    def _search_needs_review(self, operator, value):
        # Odoo อาจ normalize boolean search เป็น operator 'in'/[True]
        if isinstance(value, (list, tuple)):
            value = any(value)
        positive = operator in ('=', 'in')
        candidates = self.search([
            '|',
            ('status', '=', 'SUCCEEDED'),
            '&',
            ('status', 'not in', FINAL_STATUSES),
            ('create_date', '<',
             fields.Datetime.now() - timedelta(days=CRON_GIVE_UP_DAYS)),
        ])
        matching = candidates.filtered('needs_review')
        if positive == bool(value):
            return [('id', 'in', matching.ids)]
        return [('id', 'not in', matching.ids)]

    # ------------------------------------------------------------------
    # Hooks จาก RPC ของ pos.payment.method (เรียกด้วย sudo เสมอ)
    # ------------------------------------------------------------------
    @api.model
    def _record_created(self, payment_method, charge_id, reference_id,
                        amount_thb, expiry_time, status='PENDING'):
        if not charge_id:
            return self.browse()
        existing = self.search([('charge_id', '=', charge_id)], limit=1)
        if existing:
            # Retry ด้วย idempotency key เดิมคืน charge เดิม — ไม่สร้างแถวซ้ำ
            return existing
        if status not in dict(self._fields['status'].selection):
            status = 'PENDING'
        return self.create({
            'payment_method_id': payment_method.id,
            'charge_id': charge_id,
            'reference_id': reference_id,
            'amount_thb': amount_thb,
            'expiry_time': expiry_time,
            'status': status,
        })

    @api.model
    def _record_status(self, charge_id, status):
        if not charge_id or not status:
            return
        status = str(status).upper()
        if status not in dict(self._fields['status'].selection):
            status = 'UNKNOWN'
        record = self.search([('charge_id', '=', charge_id)], limit=1)
        if record and record.status != status:
            record.write({'status': status})
            if status == 'SUCCEEDED' and record.pos_cancelled:
                _logger.warning(
                    'Beam QR charge %s ถูกยกเลิกจากหน้าร้านแล้วแต่ลูกค้าโอนเข้า '
                    '(ยอด %.2f บาท) — ต้องกระทบยอดก่อนปิดรอบ',
                    charge_id, record.amount_thb)

    @api.model
    def _record_pos_cancelled(self, charge_id):
        if not charge_id:
            return
        record = self.search([('charge_id', '=', charge_id)], limit=1)
        if record:
            record.write({'pos_cancelled': True})

    @api.model
    def _record_manual_ref(self, payment_method, charge_id, manual_ref,
                           reference_id=None):
        record = self.search([('charge_id', '=', charge_id)], limit=1) \
            if charge_id else self.browse()
        if not record and charge_id:
            record = self.create({
                'payment_method_id': payment_method.id,
                'charge_id': charge_id,
                'reference_id': reference_id,
                'status': 'UNKNOWN',
            })
        if record:
            record.write({'manual_ref': manual_ref})
        return record

    # ------------------------------------------------------------------
    # Cron: ตามสถานะแถวที่ยังไม่จบ จนกว่าจะจบหรือแก่เกิน give-up
    # ------------------------------------------------------------------
    @api.model
    def _cron_poll_unresolved(self, batch_size=50):
        now = fields.Datetime.now()
        give_up = now - timedelta(days=CRON_GIVE_UP_DAYS)
        grace = now - timedelta(minutes=CRON_EXPIRY_GRACE_MINUTES)
        pending = self.search([
            ('status', 'not in', FINAL_STATUSES),
            ('create_date', '>=', give_up),
            # poll เฉพาะแถวที่พ้นช่วงที่ POS ยัง poll เองอยู่ (หมดอายุ+เผื่อเวลา)
            '|', ('expiry_time', '=', False), ('expiry_time', '<', grace),
        ], limit=batch_size, order='create_date asc')
        for record in pending:
            method = record.payment_method_id
            if method.sudo().use_payment_terminal != 'beam_qr':
                continue
            response = method.beam_qr_get_charge({'charge_id': record.charge_id})
            if response.get('error'):
                # เครือข่ายล่มทั้ง batch ก็เป็นได้ — รอบหน้าลองใหม่ ไม่เขียนสถานะมั่ว
                _logger.info(
                    'Beam QR cron: poll %s ไม่สำเร็จ (%s)',
                    record.charge_id, response.get('error'))
                continue
            self._record_status(record.charge_id, response.get('status'))
        return True
