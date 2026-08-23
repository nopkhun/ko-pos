# -*- coding: utf-8 -*-
import logging
import uuid

import requests

from odoo import _, fields, models
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

BEAM_PROD_BASE = 'https://api.beamcheckout.com'
BEAM_PLAYGROUND_BASE = 'https://playground.api.beamcheckout.com'
REQUEST_TIMEOUT = 20


class PosPaymentMethod(models.Model):
    _inherit = 'pos.payment.method'

    beam_merchant_id = fields.Char(
        string='Beam Merchant ID',
        help='Merchant ID จาก Beam dashboard')
    beam_api_key = fields.Char(
        string='Beam API Key',
        groups='point_of_sale.group_pos_manager',
        help='API Key จาก Beam dashboard (เก็บเป็นความลับ)')
    beam_bolt_connection_id = fields.Char(
        string='Bolt Connection ID',
        help='boltConnectionId ของเครื่อง Bolt+ ที่ pair ไว้ (เช่น boltc_xxx) '
             'ดูวิธี pair ได้ที่ docs.beamcheckout.com (Bolt Connections)')
    beam_payment_method_type = fields.Selection(
        selection=[
            ('CARD', 'บัตรเครดิต/เดบิต'),
            ('QR_PROMPT_PAY', 'QR พร้อมเพย์'),
            ('TRUE_MONEY', 'TrueMoney'),
            ('ALIPAY', 'Alipay'),
            ('WECHAT_PAY', 'WeChat Pay'),
            ('LINE_PAY', 'LINE Pay'),
            ('SHOPEE_PAY', 'ShopeePay'),
        ],
        string='ประเภทการชำระบน Bolt+', default='CARD', required=False,
        help='ประเภทการชำระเงินที่จะเปิดบนเครื่อง Bolt+ สำหรับวิธีชำระเงินนี้')
    beam_test_mode = fields.Boolean(
        string='Beam Playground (ทดสอบ)', default=False,
        help='ใช้ playground.api.beamcheckout.com สำหรับทดสอบ')
    beam_expiry_sec = fields.Integer(
        string='หมดเวลาใน (วินาที)', default=120)

    def _get_payment_terminal_selection(self):
        return super()._get_payment_terminal_selection() + [('beam_bolt', 'Beam Bolt+')]

    # ------------------------------------------------------------------
    # Beam HTTP helpers
    # ------------------------------------------------------------------
    def _beam_base_url(self):
        return BEAM_PLAYGROUND_BASE if self.beam_test_mode else BEAM_PROD_BASE

    def _beam_call(self, method, path, payload=None):
        self.ensure_one()
        sudo_self = self.sudo()
        if not sudo_self.beam_merchant_id or not sudo_self.beam_api_key:
            raise UserError(_('ยังไม่ได้ตั้งค่า Beam Merchant ID / API Key'))
        url = self._beam_base_url() + path
        try:
            resp = requests.request(
                method, url,
                json=payload,
                auth=(sudo_self.beam_merchant_id, sudo_self.beam_api_key),
                headers={'Content-Type': 'application/json'},
                timeout=REQUEST_TIMEOUT,
            )
        except requests.exceptions.RequestException as e:
            _logger.warning('Beam API connection error: %s', e)
            return {'error': _('เชื่อมต่อ Beam ไม่ได้: %s') % e}
        if resp.status_code >= 400:
            _logger.warning('Beam API error %s: %s', resp.status_code, resp.text[:500])
            try:
                body = resp.json()
            except ValueError:
                body = {}
            msg = body.get('message') or body.get('error') or resp.text[:200]
            return {'error': _('Beam API error %(code)s: %(msg)s', code=resp.status_code, msg=msg),
                    'status_code': resp.status_code}
        try:
            return resp.json() if resp.text else {}
        except ValueError:
            return {'error': _('Beam ตอบกลับข้อมูลที่อ่านไม่ได้')}

    # ------------------------------------------------------------------
    # RPC entry points (called from POS frontend)
    # ------------------------------------------------------------------
    def beam_create_bolt_intent(self, data):
        """data: {amount_thb: float, reference_id: str}"""
        self.ensure_one()
        if not self.beam_bolt_connection_id:
            return {'error': _('ยังไม่ได้ตั้งค่า Bolt Connection ID')}
        amount_satang = int(round(float(data['amount_thb']) * 100))
        if amount_satang <= 0:
            return {'error': _('ยอดเงินไม่ถูกต้อง')}
        payload = {
            'amount': amount_satang,
            'currency': 'THB',
            'boltConnectionId': self.beam_bolt_connection_id,
            'expiryDurationInSec': self.beam_expiry_sec or 120,
            'referenceId': data.get('reference_id') or uuid.uuid4().hex,
            'internalNote': data.get('note') or 'POS order',
            'mode': {'type': 'PAIRING'},
        }
        if self.beam_payment_method_type:
            payload['paymentMethod'] = {'paymentMethodType': self.beam_payment_method_type}
        result = self._beam_call('POST', '/api/v1/bolt-intents', payload)
        _logger.info('Beam create bolt intent %s -> %s', payload.get('referenceId'),
                     result.get('id') or result.get('boltIntentId') or result.get('error'))
        return result

    def beam_get_bolt_intent(self, data):
        """data: {bolt_intent_id: str}"""
        self.ensure_one()
        intent_id = data.get('bolt_intent_id')
        if not intent_id:
            return {'error': _('ไม่มี bolt intent id')}
        return self._beam_call('GET', '/api/v1/bolt-intents/%s' % intent_id)

    def beam_cancel_bolt_intent(self, data):
        """data: {bolt_intent_id: str}"""
        self.ensure_one()
        intent_id = data.get('bolt_intent_id')
        if not intent_id:
            return {'error': _('ไม่มี bolt intent id')}
        result = self._beam_call('POST', '/api/v1/bolt-intents/%s/cancel' % intent_id)
        if result.get('error') and result.get('status_code') in (404, 405):
            # Cancel endpoint unavailable — intent will simply expire on the device.
            return {'expired_fallback': True}
        return result
