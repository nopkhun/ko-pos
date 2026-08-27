# -*- coding: utf-8 -*-
import logging
import uuid
from datetime import datetime, time, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from urllib.parse import quote
from zoneinfo import ZoneInfo

import requests

from odoo import _, api, fields, models
from odoo.exceptions import UserError, ValidationError

_logger = logging.getLogger(__name__)

BEAM_PROD_BASE = 'https://api.beamcheckout.com'
BEAM_PLAYGROUND_BASE = 'https://playground.api.beamcheckout.com'
REQUEST_TIMEOUT = 20
BEAM_VOID_TIMEZONE = ZoneInfo('Asia/Bangkok')
BEAM_VOID_CUTOFF = time(19, 30)

BEAM_ENVIRONMENTS = [
    ('playground', 'Playground'),
    ('production', 'Production'),
]

BEAM_CONNECTION_STATUSES = [
    ('not_paired', 'ยังไม่ได้เชื่อมต่อ'),
    ('connected', 'เชื่อมต่อแล้ว'),
    ('invalid', 'การเชื่อมต่อใช้ไม่ได้'),
]

# ประเภทที่ขอ QR จาก Charges API มาแสดงบนจอลูกค้าได้ (actionRequired: ENCODED_IMAGE)
# QR พร้อมเพย์ใบเดียวรองรับแอปธนาคารทุกแอปและ e-wallet ที่รับ PromptPay interop
BEAM_QR_SUPPORTED_TYPES = {'QR_PROMPT_PAY'}

PAYMENT_METHOD_DETAILS = {
    'CARD': 'card',
    'CARD_INSTALLMENTS': 'cardInstallments',
    'QR_PROMPT_PAY': 'qrPromptPay',
    'ALIPAY': 'alipay',
    'ALIPAY_PLUS': 'alipayPlus',
    'WECHAT_PAY': 'weChatPay',
    'TRUE_MONEY': 'trueMoney',
    'LINE_PAY': 'linePay',
    'SHOPEE_PAY': 'shopeePay',
    'SPAY_LATER': 'sPayLater',
}


class PosPaymentMethod(models.Model):
    _inherit = 'pos.payment.method'

    beam_connection_source_id = fields.Many2one(
        'pos.payment.method',
        string='ใช้การเชื่อมต่อ Beam จาก',
        ondelete='restrict',
        help='เลือกวิธีชำระเงิน Beam ที่ Pair เครื่องนี้ไว้แล้ว เพื่อใช้ Bolt Connection '
             'เดียวกันโดยไม่ต้อง Pair อุปกรณ์ซ้ำ')
    beam_connection_dependent_ids = fields.One2many(
        'pos.payment.method', 'beam_connection_source_id',
        string='ช่องทางชำระเงินที่ใช้เครื่องนี้', readonly=True)

    beam_merchant_id = fields.Char(
        string='Beam Merchant ID',
        help='Merchant ID จาก Beam dashboard')
    beam_api_key = fields.Char(
        string='Beam API Key',
        groups='point_of_sale.group_pos_manager',
        copy=False,
        help='API Key จาก Beam dashboard (เก็บเป็นความลับ)')
    beam_pairing_code = fields.Char(
        string='รหัส Pairing จาก Beam Bolt',
        groups='point_of_sale.group_pos_manager',
        copy=False,
        help='รหัสชั่วคราวที่แสดงบนเครื่องหรือแอป Beam Bolt ใน Pairing Mode')
    beam_bolt_connection_id = fields.Char(
        string='Bolt Connection ID',
        copy=False,
        readonly=True,
        help='boltConnectionId ของเครื่อง Bolt+ ที่ pair ไว้ (เช่น boltc_xxx) '
             'ดูวิธี pair ได้ที่ docs.beamcheckout.com (Bolt Connections)')
    beam_device_id = fields.Char(
        string='Beam Device ID', copy=False, readonly=True,
        help='รหัสเครื่องที่ Beam ส่งกลับมาพร้อม Bolt Connection')
    beam_connection_environment = fields.Selection(
        selection=BEAM_ENVIRONMENTS,
        string='สภาพแวดล้อมที่ Pair', copy=False, readonly=True)
    beam_connection_status = fields.Selection(
        selection=BEAM_CONNECTION_STATUSES,
        string='สถานะเครื่อง', default='not_paired', copy=False, readonly=True)
    beam_last_checked_at = fields.Datetime(
        string='ตรวจสอบล่าสุด', copy=False, readonly=True)
    beam_payment_method_type = fields.Selection(
        selection=[
            ('CARD', 'บัตรเครดิต/เดบิต'),
            ('CARD_INSTALLMENTS', 'บัตรเครดิตแบบผ่อนชำระ'),
            ('QR_PROMPT_PAY', 'QR พร้อมเพย์'),
            ('TRUE_MONEY', 'TrueMoney'),
            ('ALIPAY', 'Alipay'),
            ('ALIPAY_PLUS', 'Alipay+'),
            ('WECHAT_PAY', 'WeChat Pay'),
            ('LINE_PAY', 'LINE Pay'),
            ('SHOPEE_PAY', 'ShopeePay'),
            ('SPAY_LATER', 'SPayLater'),
        ],
        string='ประเภทการชำระบน Bolt+', default='CARD', required=False,
        help='ประเภทการชำระเงินที่จะเปิดบนเครื่อง Bolt+ สำหรับวิธีชำระเงินนี้')
    beam_installment_period = fields.Selection(
        selection=[('3', '3 เดือน'), ('4', '4 เดือน'), ('6', '6 เดือน'), ('10', '10 เดือน')],
        string='ระยะเวลาผ่อน', default='3')
    beam_installment_issuer_group = fields.Selection(
        selection=[
            ('BangkokBank', 'ธนาคารกรุงเทพ'),
            ('CIMBThaiBank', 'ธนาคารซีไอเอ็มบี ไทย'),
            ('KasikornBank', 'ธนาคารกสิกรไทย'),
            ('KrungsriBank', 'ธนาคารกรุงศรีอยุธยา'),
            ('KrungsriFirstChoice', 'กรุงศรี เฟิร์สช้อยส์'),
            ('KrungthaiBank', 'ธนาคารกรุงไทย'),
            ('SiamCommercialBank', 'ธนาคารไทยพาณิชย์'),
            ('TMBThanachartBank', 'ธนาคารทหารไทยธนชาต'),
            ('UnitedOverseasBank', 'ธนาคารยูโอบี'),
            ('Ungrouped', 'ไม่ระบุธนาคาร'),
        ],
        string='กลุ่มธนาคารผู้ออกบัตร', default='Ungrouped')
    beam_test_mode = fields.Boolean(
        string='Beam Playground (ทดสอบ)', default=False,
        help='ใช้ playground.api.beamcheckout.com สำหรับทดสอบ')
    beam_expiry_sec = fields.Integer(
        string='หมดเวลาใน (วินาที)', default=120)
    beam_effective_bolt_connection_id = fields.Char(
        string='Bolt Connection ID ที่ใช้งาน',
        compute='_compute_beam_effective_connection')
    beam_effective_device_id = fields.Char(
        string='Beam Device ID ที่ใช้งาน',
        compute='_compute_beam_effective_connection')
    beam_effective_connection_environment = fields.Selection(
        selection=BEAM_ENVIRONMENTS,
        string='สภาพแวดล้อมที่ใช้งาน',
        compute='_compute_beam_effective_connection')
    beam_effective_connection_status = fields.Selection(
        selection=BEAM_CONNECTION_STATUSES,
        string='สถานะเครื่องที่ใช้งาน',
        compute='_compute_beam_effective_connection')
    beam_effective_last_checked_at = fields.Datetime(
        string='ตรวจสอบการเชื่อมต่อล่าสุด',
        compute='_compute_beam_effective_connection')

    def _get_payment_terminal_selection(self):
        return super()._get_payment_terminal_selection() + [
            ('beam_bolt', 'Beam Bolt+'),
            ('beam_qr', 'Beam QR (จอลูกค้า)'),
        ]

    @api.onchange('use_payment_terminal')
    def _onchange_use_payment_terminal_beam_qr(self):
        # ค่าเริ่มต้นของ beam_payment_method_type คือ CARD (สำหรับ Bolt) —
        # โหมด QR จอลูกค้ารองรับเฉพาะ QR พร้อมเพย์ จึงตั้งให้อัตโนมัติ
        if self.use_payment_terminal == 'beam_qr':
            self.beam_payment_method_type = 'QR_PROMPT_PAY'

    @api.model
    def _load_pos_data_fields(self, config):
        """Expose the Beam tender type so the refund screen can explain its route."""
        return list(dict.fromkeys(
            super()._load_pos_data_fields(config) + ['beam_payment_method_type']))

    @api.depends(
        'beam_connection_source_id',
        'beam_bolt_connection_id',
        'beam_device_id',
        'beam_connection_environment',
        'beam_connection_status',
        'beam_last_checked_at',
        'beam_connection_source_id.beam_bolt_connection_id',
        'beam_connection_source_id.beam_device_id',
        'beam_connection_source_id.beam_connection_environment',
        'beam_connection_source_id.beam_connection_status',
        'beam_connection_source_id.beam_last_checked_at',
    )
    def _compute_beam_effective_connection(self):
        for payment_method in self:
            owner = payment_method.beam_connection_source_id or payment_method
            payment_method.beam_effective_bolt_connection_id = owner.beam_bolt_connection_id
            payment_method.beam_effective_device_id = owner.beam_device_id
            payment_method.beam_effective_connection_environment = owner.beam_connection_environment
            payment_method.beam_effective_connection_status = owner.beam_connection_status
            payment_method.beam_effective_last_checked_at = owner.beam_last_checked_at

    def _beam_connection_owner(self):
        """Return the payment method that owns credentials and the Bolt Connection."""
        self.ensure_one()
        payment_method = self.sudo()
        return payment_method.beam_connection_source_id or payment_method

    @api.model_create_multi
    def create(self, vals_list):
        sanitized_vals_list = []
        for vals in vals_list:
            vals = dict(vals)
            if vals.get('beam_connection_source_id'):
                vals.update({
                    'beam_merchant_id': False,
                    'beam_api_key': False,
                    'beam_pairing_code': False,
                    'beam_test_mode': False,
                })
            sanitized_vals_list.append(vals)
        return super().create(sanitized_vals_list)

    def write(self, vals):
        for payment_method in self.filtered('beam_connection_dependent_ids'):
            dependents = payment_method.beam_connection_dependent_ids
            if (
                dependents
                and payment_method.beam_bolt_connection_id
                and vals.get('beam_bolt_connection_id', payment_method.beam_bolt_connection_id) is False
            ):
                raise UserError(_(
                    'ยังล้าง Bolt Connection ไม่ได้ เพราะมีช่องทางชำระเงินใช้เครื่องนี้อยู่: %(methods)s',
                    methods=', '.join(dependents.mapped('name')),
                ))
            if (
                dependents
                and 'company_id' in vals
                and vals['company_id'] != payment_method.company_id.id
            ):
                raise UserError(_(
                    'ยังเปลี่ยนบริษัทไม่ได้ เพราะมีช่องทางชำระเงินอื่นใช้การเชื่อมต่อ Beam นี้อยู่'))
        if vals.get('beam_connection_source_id'):
            paired_methods = self.filtered('beam_bolt_connection_id')
            if paired_methods:
                raise UserError(_(
                    'วิธีชำระเงินนี้ Pair เครื่องอยู่แล้ว กรุณายกเลิกการเชื่อมต่อเดิมก่อนเลือกใช้เครื่องร่วม'))
            vals = dict(vals)
            vals.update({
                'beam_merchant_id': False,
                'beam_api_key': False,
                'beam_pairing_code': False,
                'beam_test_mode': False,
            })
        if vals.get('use_payment_terminal') and vals['use_payment_terminal'] != 'beam_bolt':
            vals = dict(vals, beam_connection_source_id=False)
        protected_fields = {'beam_merchant_id', 'beam_api_key', 'beam_test_mode'}
        for payment_method in self.filtered('beam_bolt_connection_id'):
            disconnecting = vals.get('beam_bolt_connection_id', payment_method.beam_bolt_connection_id) is False
            changing_environment = any(
                field_name in vals and vals[field_name] != payment_method[field_name]
                for field_name in protected_fields
            )
            changing_terminal = (
                'use_payment_terminal' in vals
                and vals['use_payment_terminal'] != 'beam_bolt'
            )
            if not disconnecting and (changing_environment or changing_terminal):
                raise UserError(_(
                    'กรุณากดยกเลิกการเชื่อมต่อ Beam Bolt ก่อนเปลี่ยน Merchant ID, API Key, '
                    'Playground หรือชนิดเครื่องรับชำระ'))
        return super().write(vals)

    @api.constrains(
        'beam_connection_source_id', 'beam_bolt_connection_id',
        'company_id', 'use_payment_terminal')
    def _check_beam_connection_source(self):
        for payment_method in self.filtered('beam_connection_source_id'):
            source = payment_method.beam_connection_source_id
            if source == payment_method:
                raise ValidationError(_('วิธีชำระเงินไม่สามารถใช้การเชื่อมต่อจากตัวเองได้'))
            if source.beam_connection_source_id:
                raise ValidationError(_(
                    'กรุณาเลือกวิธีชำระเงินหลักที่ Pair เครื่องโดยตรง ไม่สามารถเชื่อมต่อเป็นทอด ๆ ได้'))
            if source.use_payment_terminal != 'beam_bolt' or not source.beam_bolt_connection_id:
                raise ValidationError(_(
                    'วิธีชำระเงินต้นทางต้องเป็น Beam Bolt+ และเชื่อมต่อเครื่องเรียบร้อยแล้ว'))
            if source.company_id != payment_method.company_id:
                raise ValidationError(_(
                    'วิธีชำระเงินที่ใช้เครื่องร่วมกันต้องอยู่ในบริษัทเดียวกัน'))
            if payment_method.use_payment_terminal != 'beam_bolt':
                raise ValidationError(_(
                    'กรุณาเลือกผสานรวมกับ Beam Bolt+ ก่อนใช้การเชื่อมต่อร่วม'))
            if payment_method.beam_bolt_connection_id:
                raise ValidationError(_(
                    'วิธีชำระเงินที่ใช้เครื่องร่วมต้องไม่มี Bolt Connection ของตัวเอง'))

    @api.constrains('beam_expiry_sec')
    def _check_beam_expiry_sec(self):
        for payment_method in self.filtered(
            lambda pm: pm.use_payment_terminal in ('beam_bolt', 'beam_qr')
        ):
            if not 90 <= payment_method.beam_expiry_sec <= 600:
                raise ValidationError(_('เวลาหมดอายุของ Beam ต้องอยู่ระหว่าง 90 ถึง 600 วินาที'))

    @api.constrains('use_payment_terminal', 'beam_payment_method_type')
    def _check_beam_qr_type(self):
        for payment_method in self.filtered(lambda pm: pm.use_payment_terminal == 'beam_qr'):
            qr_type = payment_method.beam_payment_method_type or 'QR_PROMPT_PAY'
            if qr_type not in BEAM_QR_SUPPORTED_TYPES:
                raise ValidationError(_(
                    'Beam QR บนจอลูกค้ารองรับเฉพาะ QR พร้อมเพย์ '
                    '(ใบเดียวจ่ายได้ทั้งแอปธนาคารและ e-wallet ที่รองรับ PromptPay)'))

    # ------------------------------------------------------------------
    # Beam HTTP helpers
    # ------------------------------------------------------------------
    def _beam_base_url(self):
        self.ensure_one()
        owner = self._beam_connection_owner()
        return BEAM_PLAYGROUND_BASE if owner.beam_test_mode else BEAM_PROD_BASE

    def _beam_environment(self):
        self.ensure_one()
        owner = self._beam_connection_owner()
        return 'playground' if owner.beam_test_mode else 'production'

    def _beam_call(self, method, path, payload=None, idempotency_key=None):
        self.ensure_one()
        owner = self._beam_connection_owner()
        if not owner.beam_merchant_id or not owner.beam_api_key:
            return {'error': _('ยังไม่ได้ตั้งค่า Beam Merchant ID / API Key'), 'status_code': 400}
        url = self._beam_base_url() + path
        headers = {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
        }
        if idempotency_key and method.upper() in ('POST', 'PATCH'):
            headers['x-beam-idempotency-key'] = str(idempotency_key)[:255]
        try:
            resp = requests.request(
                method.upper(), url,
                json=payload,
                auth=(owner.beam_merchant_id, owner.beam_api_key),
                headers=headers,
                timeout=REQUEST_TIMEOUT,
            )
        except requests.exceptions.RequestException as e:
            _logger.warning('Beam API connection error on %s %s: %s', method, path, e)
            return {
                'error': _('เชื่อมต่อ Beam ไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง'),
                'retryable': True,
            }
        if resp.status_code >= 400:
            try:
                body = resp.json()
            except ValueError:
                body = {}
            error_data = body.get('error') if isinstance(body, dict) else None
            if isinstance(error_data, dict):
                detail = error_data.get('errorMessage') or error_data.get('errorCode')
                error_code = error_data.get('errorCode')
            else:
                detail = body.get('message') if isinstance(body, dict) else None
                error_code = error_data if isinstance(error_data, str) else None
            detail = detail or _('Beam ปฏิเสธคำขอ')
            request_id = resp.headers.get('x-request-id') or resp.headers.get('x-beam-request-id')
            _logger.warning(
                'Beam API error on %s %s: status=%s code=%s request_id=%s',
                method, path, resp.status_code, error_code, request_id,
            )
            return {
                'error': _('Beam API error %(code)s: %(msg)s', code=resp.status_code, msg=detail),
                'error_code': error_code,
                'status_code': resp.status_code,
                'request_id': request_id,
                'retryable': resp.status_code == 429 or resp.status_code >= 500,
            }
        try:
            return resp.json() if resp.text else {}
        except ValueError:
            return {'error': _('Beam ตอบกลับข้อมูลที่อ่านไม่ได้')}

    def _beam_raise_for_error(self, result):
        if result.get('error'):
            raise UserError(result['error'])

    def _beam_validate_connection_environment(self):
        self.ensure_one()
        owner = self._beam_connection_owner()
        if (
            owner.beam_connection_environment
            and owner.beam_connection_environment != self._beam_environment()
        ):
            raise UserError(_(
                'Bolt Connection นี้ Pair อยู่กับ %(paired)s แต่กำลังตั้งค่าเป็น %(current)s '
                'กรุณาเปลี่ยนกลับไปสภาพแวดล้อมเดิม หรือยกเลิกการเชื่อมต่อแล้ว Pair ใหม่',
                paired=owner.beam_connection_environment,
                current=self._beam_environment(),
            ))

    # ------------------------------------------------------------------
    # Configuration actions (called from the payment-method form)
    # ------------------------------------------------------------------
    def action_beam_pair(self):
        self.ensure_one()
        sudo_self = self.sudo()
        if sudo_self.use_payment_terminal != 'beam_bolt':
            raise UserError(_('กรุณาเลือกการเชื่อมต่อเป็น Beam Bolt+ ก่อน'))
        if sudo_self.beam_connection_source_id:
            raise UserError(_(
                'วิธีชำระเงินนี้ใช้เครื่องที่ Pair ไว้แล้ว จึงไม่ต้อง Pair ซ้ำ'))
        if sudo_self.beam_bolt_connection_id:
            raise UserError(_('วิธีชำระเงินนี้เชื่อมต่อเครื่องอยู่แล้ว กรุณายกเลิกการเชื่อมต่อเดิมก่อน'))
        pairing_code = (sudo_self.beam_pairing_code or '').strip()
        if not pairing_code:
            raise UserError(_('กรุณากรอกรหัส Pairing ตามที่แสดงบนเครื่องหรือแอป Beam Bolt'))
        result = self._beam_call(
            'POST',
            '/api/v1/bolt-connections',
            {'pairingCode': pairing_code},
            idempotency_key=str(uuid.uuid4()),
        )
        self._beam_raise_for_error(result)
        connection_id = result.get('id')
        device_id = result.get('deviceId')
        if not connection_id or not device_id:
            raise UserError(_('Beam ตอบกลับไม่ครบ: ไม่พบ Bolt Connection ID หรือ Device ID'))
        self.write({
            'beam_pairing_code': False,
            'beam_bolt_connection_id': connection_id,
            'beam_device_id': device_id,
            'beam_connection_environment': self._beam_environment(),
            'beam_connection_status': 'connected',
            'beam_last_checked_at': fields.Datetime.now(),
        })
        return self._beam_notification(_('เชื่อมต่อ Beam Bolt สำเร็จ'), _(
            'เครื่อง %(device)s พร้อมรับยอดจาก POS แล้ว', device=device_id))

    def action_beam_check_connection(self):
        self.ensure_one()
        owner = self._beam_connection_owner()
        if not owner.beam_bolt_connection_id:
            raise UserError(_('ยังไม่ได้เชื่อมต่อเครื่อง Beam Bolt'))
        self._beam_validate_connection_environment()
        result = self._beam_call(
            'GET', '/api/v1/bolt-connections/%s' % owner.beam_bolt_connection_id)
        if result.get('error'):
            if result.get('status_code') == 404:
                owner.write({
                    'beam_connection_status': 'invalid',
                    'beam_last_checked_at': fields.Datetime.now(),
                })
            self._beam_raise_for_error(result)
        device_id = result.get('deviceId') or owner.beam_device_id
        owner.write({
            'beam_device_id': device_id,
            'beam_connection_environment': (
                owner.beam_connection_environment or self._beam_environment()),
            'beam_connection_status': 'connected',
            'beam_last_checked_at': fields.Datetime.now(),
        })
        return self._beam_notification(
            _('การเชื่อมต่อใช้งานได้'),
            _('Beam Bolt เครื่อง %(device)s เชื่อมต่ออยู่', device=device_id or '-'))

    def action_beam_disconnect(self):
        self.ensure_one()
        sudo_self = self.sudo()
        if sudo_self.beam_connection_source_id:
            raise UserError(_(
                'วิธีชำระเงินนี้ใช้การเชื่อมต่อร่วม กรุณาเปิดวิธีชำระเงินหลักหากต้องการยกเลิกการเชื่อมต่อ'))
        if not sudo_self.beam_bolt_connection_id:
            raise UserError(_('ยังไม่ได้เชื่อมต่อเครื่อง Beam Bolt'))
        dependents = sudo_self.beam_connection_dependent_ids
        if dependents:
            raise UserError(_(
                'ยังยกเลิกการเชื่อมต่อไม่ได้ เพราะมีช่องทางชำระเงินใช้เครื่องนี้อยู่: %(methods)s '
                'กรุณาเปลี่ยนช่องทางเหล่านั้นให้เลิกใช้การเชื่อมต่อนี้ก่อน',
                methods=', '.join(dependents.mapped('name')),
            ))
        self._beam_validate_connection_environment()
        result = self._beam_call(
            'DELETE', '/api/v1/bolt-connections/%s' % sudo_self.beam_bolt_connection_id)
        self._beam_raise_for_error(result)
        self.write({
            'beam_pairing_code': False,
            'beam_bolt_connection_id': False,
            'beam_device_id': False,
            'beam_connection_environment': False,
            'beam_connection_status': 'not_paired',
            'beam_last_checked_at': fields.Datetime.now(),
        })
        return self._beam_notification(
            _('ยกเลิกการเชื่อมต่อแล้ว'),
            _('เครื่อง Beam Bolt ออกจากระบบแล้ว ต้องเข้าสู่ระบบใหม่ก่อน Pair ครั้งถัดไป'),
            notification_type='warning')

    @staticmethod
    def _beam_notification(title, message, notification_type='success'):
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': title,
                'message': message,
                'type': notification_type,
                'sticky': False,
            },
        }

    # ------------------------------------------------------------------
    # RPC entry points (called from POS frontend)
    # ------------------------------------------------------------------
    def beam_create_bolt_intent(self, data):
        """data: {amount_thb: float, reference_id: str}"""
        self.ensure_one()
        sudo_self = self.sudo()
        owner = self._beam_connection_owner()
        if sudo_self.use_payment_terminal != 'beam_bolt':
            return {'error': _('วิธีชำระเงินนี้ไม่ได้ตั้งค่าเป็น Beam Bolt+')}
        if not owner.beam_bolt_connection_id:
            return {'error': _('ยังไม่ได้ตั้งค่า Bolt Connection ID')}
        try:
            amount_satang = int(
                (Decimal(str(data.get('amount_thb'))) * 100).quantize(
                    Decimal('1'), rounding=ROUND_HALF_UP))
        except (InvalidOperation, TypeError, ValueError):
            return {'error': _('ยอดเงินไม่ถูกต้อง')}
        if amount_satang <= 0:
            return {'error': _('ยอดเงินไม่ถูกต้อง')}
        try:
            self._beam_validate_connection_environment()
        except UserError as error:
            return {'error': error.args[0]}
        expiry_sec = sudo_self.beam_expiry_sec or 120
        if not 90 <= expiry_sec <= 600:
            return {'error': _('เวลาหมดอายุของ Beam Bolt ต้องอยู่ระหว่าง 90 ถึง 600 วินาที')}
        reference_id = str(data.get('reference_id') or uuid.uuid4().hex)[:100]
        payment_method_type = sudo_self.beam_payment_method_type or 'CARD'
        detail_key = PAYMENT_METHOD_DETAILS[payment_method_type]
        payment_method = {'paymentMethodType': payment_method_type, detail_key: {}}
        if payment_method_type == 'CARD_INSTALLMENTS':
            payment_method[detail_key] = {
                'installmentPeriod': int(sudo_self.beam_installment_period or 3),
                'issuerGroup': sudo_self.beam_installment_issuer_group or 'Ungrouped',
            }
        payload = {
            'amount': amount_satang,
            'currency': 'THB',
            'boltConnectionId': owner.beam_bolt_connection_id,
            'expiryDurationInSec': expiry_sec,
            'referenceId': reference_id,
            'internalNote': str(data.get('note') or 'POS order')[:500],
            'mode': {'type': 'PAIRING'},
            'paymentMethod': payment_method,
        }
        result = self._beam_call(
            'POST', '/api/v1/bolt-intents', payload,
            idempotency_key=data.get('idempotency_key') or str(uuid.uuid4()))
        _logger.info(
            'Beam create bolt intent reference=%s intent=%s status=%s request_id=%s',
            reference_id,
            result.get('id') or result.get('boltIntentId'),
            result.get('status_code', 201 if result.get('id') else None),
            result.get('request_id'),
        )
        return result

    def beam_get_bolt_intent(self, data):
        """data: {bolt_intent_id: str}"""
        self.ensure_one()
        if self.sudo().use_payment_terminal != 'beam_bolt':
            return {'error': _('วิธีชำระเงินนี้ไม่ได้ตั้งค่าเป็น Beam Bolt+')}
        intent_id = data.get('bolt_intent_id')
        if not intent_id:
            return {'error': _('ไม่มี bolt intent id')}
        return self._beam_call(
            'GET', '/api/v1/bolt-intents/%s' % quote(str(intent_id), safe=''))

    def beam_cancel_bolt_intent(self, data):
        """data: {bolt_intent_id: str}"""
        self.ensure_one()
        if self.sudo().use_payment_terminal != 'beam_bolt':
            return {'error': _('วิธีชำระเงินนี้ไม่ได้ตั้งค่าเป็น Beam Bolt+')}
        intent_id = data.get('bolt_intent_id')
        if not intent_id:
            return {'error': _('ไม่มี bolt intent id')}
        return self._beam_call(
            'PATCH',
            '/api/v1/bolt-intents/%s/cancel' % quote(str(intent_id), safe=''),
            idempotency_key=data.get('idempotency_key') or str(uuid.uuid4()),
        )

    # ------------------------------------------------------------------
    # Beam QR on the customer display (Charges API)
    # ------------------------------------------------------------------
    def beam_qr_create_charge(self, data):
        """data: {amount_thb: float, reference_id: str, idempotency_key: str}

        สร้าง charge แบบ QR แล้วคืนภาพ QR (base64) ให้ POS ส่งขึ้นจอลูกค้า
        Charges API ไม่มี endpoint ยกเลิก — QR ตายด้วย expiryTime เท่านั้น
        จึงตั้งอายุสั้นตาม beam_expiry_sec (ค่าเริ่มต้น 120 วินาที)
        """
        self.ensure_one()
        sudo_self = self.sudo()
        if sudo_self.use_payment_terminal != 'beam_qr':
            return {'error': _('วิธีชำระเงินนี้ไม่ได้ตั้งค่าเป็น Beam QR')}
        if not sudo_self.beam_merchant_id or not sudo_self.beam_api_key:
            return {'error': _('ยังไม่ได้ตั้งค่า Beam Merchant ID / API Key')}
        try:
            amount_satang = int(
                (Decimal(str(data.get('amount_thb'))) * 100).quantize(
                    Decimal('1'), rounding=ROUND_HALF_UP))
        except (InvalidOperation, TypeError, ValueError):
            return {'error': _('ยอดเงินไม่ถูกต้อง')}
        if amount_satang <= 0:
            return {'error': _('ยอดเงินไม่ถูกต้อง')}
        payment_method_type = sudo_self.beam_payment_method_type or 'QR_PROMPT_PAY'
        if payment_method_type not in BEAM_QR_SUPPORTED_TYPES:
            return {'error': _('ประเภท QR นี้ยังไม่รองรับบนจอลูกค้า')}
        expiry_sec = sudo_self.beam_expiry_sec or 120
        expiry_sec = min(600, max(90, expiry_sec))
        expiry_time = (fields.Datetime.now() + timedelta(seconds=expiry_sec)).strftime(
            '%Y-%m-%dT%H:%M:%SZ')
        reference_id = str(data.get('reference_id') or uuid.uuid4().hex)[:100]
        detail_key = PAYMENT_METHOD_DETAILS[payment_method_type]
        payload = {
            'amount': amount_satang,
            'currency': 'THB',
            'referenceId': reference_id,
            'returnUrl': self.get_base_url(),
            'paymentMethod': {
                'paymentMethodType': payment_method_type,
                detail_key: {'expiryTime': expiry_time},
            },
        }
        result = self._beam_call(
            'POST', '/api/v1/charges', payload,
            idempotency_key=data.get('idempotency_key') or str(uuid.uuid4()))
        if result.get('error'):
            return result
        charge_id = result.get('chargeId') or result.get('id')
        encoded = result.get('encodedImage') or {}
        _logger.info(
            'Beam create charge reference=%s charge=%s action=%s',
            reference_id, charge_id, result.get('actionRequired'),
        )
        if not charge_id:
            return {'error': _(
                'Beam ไม่ส่ง Charge ID กลับมา กรุณาอย่าสร้างรายการใหม่และตรวจสอบ Lighthouse')}
        if not encoded.get('imageBase64Encoded'):
            # charge อาจถูกสร้างแล้วที่ Beam — ห้ามให้ Retry สร้างซ้ำโดยไม่บอกพนักงาน
            return {
                'error': _(
                    'Beam ไม่ส่งภาพ QR กลับมา กรุณาตรวจสอบรายการ %s ใน Lighthouse '
                    'ก่อนลองใหม่', charge_id),
                'charge_id': charge_id,
            }
        return {
            'charge_id': charge_id,
            'status': result.get('status') or 'PENDING',
            'qr_image_base64': encoded['imageBase64Encoded'],
            'qr_expiry': encoded.get('expiry') or expiry_time,
        }

    def beam_qr_get_charge(self, data):
        """data: {charge_id: str}"""
        self.ensure_one()
        if self.sudo().use_payment_terminal != 'beam_qr':
            return {'error': _('วิธีชำระเงินนี้ไม่ได้ตั้งค่าเป็น Beam QR')}
        charge_id = data.get('charge_id')
        if not charge_id:
            return {'error': _('ไม่มี charge id')}
        return self._beam_call(
            'GET', '/api/v1/charges/%s' % quote(str(charge_id), safe=''))

    # ------------------------------------------------------------------
    # Same-day card voids from POS
    # ------------------------------------------------------------------
    @staticmethod
    def _beam_bangkok_now():
        return datetime.now(BEAM_VOID_TIMEZONE)

    @staticmethod
    def _beam_as_bangkok(value):
        value = fields.Datetime.to_datetime(value)
        if not value:
            return False
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(BEAM_VOID_TIMEZONE)

    def _beam_pos_void_payment(self, data):
        """Return the verified original POS payment or an error payload.

        The store's settlement rule is deliberately enforced on the server:
        only a same-day CARD payment, made before 19:30 Asia/Bangkok, can be
        reversed from the till, and the reversal itself must also be requested
        before 19:30. Everything else belongs in Beam Lighthouse.
        """
        self.ensure_one()
        payment_method = self.sudo()
        if payment_method.use_payment_terminal != 'beam_bolt':
            return False, {'error': _('วิธีชำระเงินนี้ไม่ได้ตั้งค่าเป็น Beam Bolt+')}
        if payment_method.beam_payment_method_type != 'CARD':
            return False, {
                'error': _('ช่องทางนี้ไม่รองรับ Void จาก POS กรุณาดำเนินการใน Beam Lighthouse'),
                'external_required': True,
                'error_code': 'LIGHTHOUSE_REQUIRED',
            }

        try:
            payment_id = int(data.get('original_payment_id'))
        except (TypeError, ValueError):
            payment_id = 0
        payment = self.env['pos.payment'].sudo().browse(payment_id).exists()
        if not payment or payment.payment_method_id != payment_method:
            return False, {
                'error': _('ไม่พบรายการบัตรต้นฉบับ กรุณาตรวจสอบและดำเนินการใน Beam Lighthouse'),
                'external_required': True,
                'error_code': 'ORIGINAL_PAYMENT_NOT_FOUND',
            }
        if payment.company_id not in self.env.companies:
            return False, {'error': _('ไม่มีสิทธิ์คืนรายการของบริษัทนี้')}

        charge_id = str(data.get('charge_id') or '').strip()
        if not charge_id.startswith('ch_') or payment.transaction_id != charge_id:
            return False, {
                'error': _('บิลนี้ไม่มี Beam Charge ID ที่ใช้ Void อัตโนมัติ กรุณาดำเนินการใน Beam Lighthouse'),
                'external_required': True,
                'error_code': 'CHARGE_ID_REQUIRED',
            }

        now = self._beam_bangkok_now()
        paid_at = self._beam_as_bangkok(payment.payment_date)
        same_day_before_cutoff_payment = bool(
            paid_at
            and paid_at.date() == now.date()
            and paid_at.time().replace(tzinfo=None) < BEAM_VOID_CUTOFF
        )
        recovering_ambiguous_request = bool(data.get('recovery'))
        if (
            not same_day_before_cutoff_payment
            or (
                now.time().replace(tzinfo=None) >= BEAM_VOID_CUTOFF
                and not recovering_ambiguous_request
            )
        ):
            return False, {
                'error': _(
                    'เลยช่วง Void ก่อน 19:30 น. แล้ว กรุณาคืนรายการบัตรใน Beam Lighthouse '
                    'และกลับมาบันทึกเลขอ้างอิงใน POS'),
                'external_required': True,
                'error_code': 'VOID_WINDOW_CLOSED',
            }

        try:
            amount_satang = int(
                (Decimal(str(data.get('amount_thb'))) * 100).quantize(
                    Decimal('1'), rounding=ROUND_HALF_UP))
        except (InvalidOperation, TypeError, ValueError):
            amount_satang = 0
        original_satang = int(
            (Decimal(str(payment.amount)) * 100).quantize(
                Decimal('1'), rounding=ROUND_HALF_UP))
        if amount_satang <= 0 or amount_satang > original_satang:
            return False, {'error': _('ยอด Void ไม่ถูกต้องหรือเกินยอดบัตรต้นฉบับ')}
        return payment, {
            'charge_id': charge_id,
            'amount_satang': amount_satang,
            'paid_at': paid_at,
        }

    def beam_create_pos_void(self, data):
        """Create a Beam Refund resource inside the store's same-day void window."""
        self.ensure_one()
        payment, verified = self._beam_pos_void_payment(data or {})
        if not payment:
            return verified
        idempotency_key = str((data or {}).get('idempotency_key') or '').strip()
        if not idempotency_key:
            return {'error': _('ไม่พบรหัสป้องกันการส่ง Void ซ้ำ')}
        reason = str((data or {}).get('reason') or 'KO POS same-day void')[:500]
        result = self._beam_call(
            'POST',
            '/api/v1/refunds',
            {
                'chargeId': verified['charge_id'],
                'reason': reason,
                'amount': verified['amount_satang'],
            },
            idempotency_key=idempotency_key,
        )
        _logger.info(
            'Beam POS void order=%s payment=%s charge=%s refund=%s status=%s request_id=%s',
            payment.pos_order_id.pos_reference or payment.pos_order_id.name,
            payment.id,
            verified['charge_id'],
            result.get('refundId') or result.get('id'),
            result.get('status') or result.get('status_code'),
            result.get('request_id'),
        )
        return result

    def beam_get_refund(self, data):
        """Read a refund and, when available, its reconciliation transaction type."""
        self.ensure_one()
        if self.sudo().use_payment_terminal != 'beam_bolt':
            return {'error': _('วิธีชำระเงินนี้ไม่ได้ตั้งค่าเป็น Beam Bolt+')}
        refund_id = str((data or {}).get('refund_id') or '').strip()
        if not refund_id.startswith('re_'):
            return {'error': _('ไม่พบ Beam Refund ID')}
        result = self._beam_call(
            'GET', '/api/v1/refunds/%s' % quote(refund_id, safe=''))
        if result.get('error') or str(result.get('status') or '').upper() != 'SUCCEEDED':
            return result

        # Beam decides whether the successful reversal is booked as VOID or
        # REFUND. The Refund resource does not expose that distinction, so read
        # the immutable transaction opportunistically for receipts/reconciliation.
        transaction = self._beam_call(
            'GET', '/api/v1/transactions/%s' % quote(refund_id, safe=''))
        if not transaction.get('error'):
            result['transactionType'] = transaction.get('transactionType')
        return result
