from unittest.mock import Mock, patch
from datetime import datetime
from zoneinfo import ZoneInfo

from odoo.exceptions import UserError, ValidationError
from odoo.tests.common import TransactionCase


REQUESTS_TARGET = (
    'odoo.addons.ko_pos_beam_bolt.models.pos_payment_method.requests.request')
NOW_TARGET = (
    'odoo.addons.ko_pos_beam_bolt.models.pos_payment_method.'
    'PosPaymentMethod._beam_bangkok_now')


class TestBeamBolt(TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.method = cls.env['pos.payment.method'].create({
            'name': 'Beam Bolt Test',
            'split_transactions': True,
            'payment_method_type': 'terminal',
            'use_payment_terminal': 'beam_bolt',
            'beam_merchant_id': 'merchant_test',
            'beam_api_key': 'api_key_test',
            'beam_test_mode': True,
            'beam_expiry_sec': 120,
            'beam_payment_method_type': 'QR_PROMPT_PAY',
        })

    @staticmethod
    def _response(status_code, body=None):
        response = Mock()
        response.status_code = status_code
        response.headers = {'x-request-id': 'req_test'}
        response.text = '' if body is None else 'json'
        response.json.return_value = body
        return response

    def _original_card_payment(self, *, payment_date, transaction_id='ch_void_test', amount=100):
        self.method.write({'beam_payment_method_type': 'CARD'})
        config = self.env['pos.config'].create({
            'name': 'Beam Void Test POS',
            'payment_method_ids': [(6, 0, self.method.ids)],
        })
        session = self.env['pos.session'].create({
            'config_id': config.id,
            'user_id': self.env.user.id,
        })
        order = self.env['pos.order'].create({
            'session_id': session.id,
            'company_id': self.env.company.id,
            'amount_tax': 0,
            'amount_total': amount,
            'amount_paid': amount,
            'amount_return': 0,
        })
        return self.env['pos.payment'].create({
            'pos_order_id': order.id,
            'amount': amount,
            'payment_method_id': self.method.id,
            'payment_date': payment_date,
            'transaction_id': transaction_id,
        })

    @patch(REQUESTS_TARGET)
    def test_pair_check_and_disconnect(self, request):
        self.method.beam_pairing_code = '12345678'
        request.return_value = self._response(201, {
            'id': 'boltc_test',
            'deviceId': 'device_test',
            'merchantId': 'merchant_test',
        })

        self.method.action_beam_pair()

        self.assertEqual(self.method.beam_bolt_connection_id, 'boltc_test')
        self.assertEqual(self.method.beam_device_id, 'device_test')
        self.assertEqual(self.method.beam_connection_environment, 'playground')
        self.assertEqual(self.method.beam_connection_status, 'connected')
        call = request.call_args
        self.assertEqual(call.args[:2], ('POST', 'https://playground.api.beamcheckout.com/api/v1/bolt-connections'))
        self.assertEqual(call.kwargs['json'], {'pairingCode': '12345678'})
        self.assertTrue(call.kwargs['headers']['x-beam-idempotency-key'])

        request.return_value = self._response(200, {
            'id': 'boltc_test',
            'deviceId': 'device_test',
            'merchantId': 'merchant_test',
        })
        self.method.action_beam_check_connection()
        self.assertEqual(request.call_args.args[0], 'GET')

        request.return_value = self._response(202)
        self.method.action_beam_disconnect()
        self.assertEqual(request.call_args.args[0], 'DELETE')
        self.assertFalse(self.method.beam_bolt_connection_id)
        self.assertEqual(self.method.beam_connection_status, 'not_paired')

    @patch(REQUESTS_TARGET)
    def test_pairing_code_is_required(self, request):
        self.method.beam_pairing_code = '   '
        with self.assertRaises(UserError):
            self.method.action_beam_pair()
        request.assert_not_called()

    def test_cannot_switch_environment_while_paired(self):
        self.method.write({
            'beam_bolt_connection_id': 'boltc_test',
            'beam_connection_environment': 'playground',
        })
        with self.assertRaises(UserError):
            self.method.beam_test_mode = False
        self.method.write({
            'beam_bolt_connection_id': False,
            'beam_connection_environment': False,
        })

    @patch(REQUESTS_TARGET)
    def test_shared_connection_uses_owner_credentials_and_own_payment_type(self, request):
        self.method.write({
            'beam_bolt_connection_id': 'boltc_shared',
            'beam_device_id': 'device_shared',
            'beam_connection_environment': 'playground',
            'beam_connection_status': 'connected',
            'beam_payment_method_type': 'CARD',
        })
        promptpay = self.env['pos.payment.method'].create({
            'name': 'Beam PromptPay',
            'split_transactions': True,
            'payment_method_type': 'terminal',
            'use_payment_terminal': 'beam_bolt',
            'beam_connection_source_id': self.method.id,
            'beam_expiry_sec': 120,
            'beam_payment_method_type': 'QR_PROMPT_PAY',
        })
        self.assertFalse(promptpay.beam_merchant_id)
        self.assertFalse(promptpay.beam_api_key)
        request.return_value = self._response(201, {
            'id': 'bolti_shared',
            'status': 'ACTIVE',
        })

        result = promptpay.beam_create_bolt_intent({
            'amount_thb': 50,
            'reference_id': 'shared-001',
            'idempotency_key': 'shared-idem',
        })

        self.assertEqual(result['id'], 'bolti_shared')
        call = request.call_args
        self.assertEqual(call.args[:2], (
            'POST', 'https://playground.api.beamcheckout.com/api/v1/bolt-intents'))
        self.assertEqual(call.kwargs['auth'], ('merchant_test', 'api_key_test'))
        self.assertEqual(call.kwargs['json']['boltConnectionId'], 'boltc_shared')
        self.assertEqual(call.kwargs['json']['paymentMethod'], {
            'paymentMethodType': 'QR_PROMPT_PAY',
            'qrPromptPay': {},
        })
        self.assertEqual(promptpay.beam_effective_device_id, 'device_shared')
        self.assertEqual(promptpay.beam_effective_connection_status, 'connected')

        request.return_value = self._response(200, {
            'id': 'boltc_shared',
            'deviceId': 'device_shared',
            'merchantId': 'merchant_test',
        })
        promptpay.action_beam_check_connection()
        self.assertEqual(request.call_args.args[:2], (
            'GET', 'https://playground.api.beamcheckout.com/api/v1/bolt-connections/boltc_shared'))
        self.assertTrue(self.method.beam_last_checked_at)

    @patch(REQUESTS_TARGET)
    def test_shared_method_does_not_pair_or_disconnect_device(self, request):
        self.method.write({
            'beam_bolt_connection_id': 'boltc_shared',
            'beam_connection_environment': 'playground',
            'beam_connection_status': 'connected',
        })
        promptpay = self.env['pos.payment.method'].create({
            'name': 'Beam PromptPay',
            'payment_method_type': 'terminal',
            'use_payment_terminal': 'beam_bolt',
            'beam_connection_source_id': self.method.id,
            'beam_expiry_sec': 120,
            'beam_payment_method_type': 'QR_PROMPT_PAY',
        })

        with self.assertRaises(UserError):
            promptpay.action_beam_pair()
        with self.assertRaises(UserError):
            promptpay.action_beam_disconnect()
        with self.assertRaises(UserError):
            self.method.action_beam_disconnect()
        request.assert_not_called()

    def test_shared_connection_must_be_direct_paired_and_same_company(self):
        unpaired = self.env['pos.payment.method'].create({
            'name': 'Beam Unpaired',
            'payment_method_type': 'terminal',
            'use_payment_terminal': 'beam_bolt',
            'beam_merchant_id': 'merchant_test',
            'beam_api_key': 'api_key_test',
            'beam_expiry_sec': 120,
        })
        with self.assertRaises(ValidationError):
            self.env['pos.payment.method'].create({
                'name': 'Beam Invalid Shared',
                'payment_method_type': 'terminal',
                'use_payment_terminal': 'beam_bolt',
                'beam_connection_source_id': unpaired.id,
                'beam_expiry_sec': 120,
            })

        self.method.write({
            'beam_bolt_connection_id': 'boltc_shared',
            'beam_connection_environment': 'playground',
            'beam_connection_status': 'connected',
        })
        other_company = self.env['res.company'].create({'name': 'Beam Other Company'})
        with self.assertRaises(ValidationError):
            self.env['pos.payment.method'].create({
                'name': 'Beam Cross Company',
                'company_id': other_company.id,
                'payment_method_type': 'terminal',
                'use_payment_terminal': 'beam_bolt',
                'beam_connection_source_id': self.method.id,
                'beam_expiry_sec': 120,
            })

    def test_shared_connection_cannot_chain(self):
        self.method.write({
            'beam_bolt_connection_id': 'boltc_shared',
            'beam_connection_environment': 'playground',
            'beam_connection_status': 'connected',
        })
        promptpay = self.env['pos.payment.method'].create({
            'name': 'Beam PromptPay',
            'payment_method_type': 'terminal',
            'use_payment_terminal': 'beam_bolt',
            'beam_connection_source_id': self.method.id,
            'beam_expiry_sec': 120,
        })
        with self.assertRaises(ValidationError):
            self.env['pos.payment.method'].create({
                'name': 'Beam Chained',
                'payment_method_type': 'terminal',
                'use_payment_terminal': 'beam_bolt',
                'beam_connection_source_id': promptpay.id,
                'beam_expiry_sec': 120,
            })

    @patch(REQUESTS_TARGET)
    def test_create_qr_bolt_intent_uses_v1_schema_and_idempotency(self, request):
        self.method.write({
            'beam_bolt_connection_id': 'boltc_test',
            'beam_device_id': 'device_test',
            'beam_connection_environment': 'playground',
            'beam_connection_status': 'connected',
        })
        request.return_value = self._response(201, {
            'id': 'bolti_test',
            'status': 'ACTIVE',
        })

        result = self.method.beam_create_bolt_intent({
            'amount_thb': 21.25,
            'reference_id': 'order-001',
            'note': 'Table 1',
            'idempotency_key': 'idem-test',
        })

        self.assertEqual(result['id'], 'bolti_test')
        call = request.call_args
        self.assertEqual(call.args[:2], ('POST', 'https://playground.api.beamcheckout.com/api/v1/bolt-intents'))
        self.assertEqual(call.kwargs['json']['amount'], 2125)
        self.assertEqual(call.kwargs['json']['mode'], {'type': 'PAIRING'})
        self.assertEqual(call.kwargs['json']['paymentMethod'], {
            'paymentMethodType': 'QR_PROMPT_PAY',
            'qrPromptPay': {},
        })
        self.assertEqual(call.kwargs['headers']['x-beam-idempotency-key'], 'idem-test')

    @patch(REQUESTS_TARGET)
    def test_installment_payload(self, request):
        self.method.write({
            'beam_bolt_connection_id': 'boltc_test',
            'beam_connection_environment': 'playground',
            'beam_payment_method_type': 'CARD_INSTALLMENTS',
            'beam_installment_period': '6',
            'beam_installment_issuer_group': 'KasikornBank',
        })
        request.return_value = self._response(201, {'id': 'bolti_installment'})

        self.method.beam_create_bolt_intent({'amount_thb': '1000.00'})

        self.assertEqual(request.call_args.kwargs['json']['paymentMethod'], {
            'paymentMethodType': 'CARD_INSTALLMENTS',
            'cardInstallments': {
                'installmentPeriod': 6,
                'issuerGroup': 'KasikornBank',
            },
        })

    @patch(REQUESTS_TARGET)
    def test_cancel_bolt_intent_uses_patch(self, request):
        request.return_value = self._response(202)

        self.method.beam_cancel_bolt_intent({
            'bolt_intent_id': 'bolti_test',
            'idempotency_key': 'cancel-test',
        })

        self.assertEqual(request.call_args.args[0], 'PATCH')
        self.assertTrue(request.call_args.args[1].endswith('/api/v1/bolt-intents/bolti_test/cancel'))
        self.assertEqual(request.call_args.kwargs['headers']['x-beam-idempotency-key'], 'cancel-test')

    @patch(REQUESTS_TARGET)
    def test_nested_beam_error_is_safe_and_retryable(self, request):
        request.return_value = self._response(429, {
            'code': 429,
            'error': {
                'errorCode': 'TOO_MANY_REQUESTS_ERROR',
                'errorMessage': 'Please retry later',
            },
        })

        result = self.method.beam_get_bolt_intent({'bolt_intent_id': 'bolti_test'})

        self.assertEqual(result['status_code'], 429)
        self.assertEqual(result['error_code'], 'TOO_MANY_REQUESTS_ERROR')
        self.assertTrue(result['retryable'])
        self.assertNotIn('api_key_test', result['error'])

    def test_expiry_matches_beam_limits(self):
        with self.assertRaises(ValidationError):
            self.method.beam_expiry_sec = 30

    def test_pos_load_includes_beam_payment_type_for_refund_routing(self):
        self.assertIn('beam_payment_method_type', self.method._load_pos_data_fields(False))

    @patch(REQUESTS_TARGET)
    def test_same_day_card_before_cutoff_creates_beam_void(self, request):
        payment = self._original_card_payment(
            payment_date=datetime(2026, 8, 26, 12, 0),  # 19:00 Asia/Bangkok
        )
        request.return_value = self._response(201, {'refundId': 're_void_test'})
        now = datetime(2026, 8, 26, 19, 15, tzinfo=ZoneInfo('Asia/Bangkok'))

        with patch(NOW_TARGET, return_value=now):
            result = self.method.beam_create_pos_void({
                'original_payment_id': payment.id,
                'charge_id': 'ch_void_test',
                'amount_thb': 40.25,
                'reason': 'Customer canceled',
                'idempotency_key': 'void-idem-test',
            })

        self.assertEqual(result['refundId'], 're_void_test')
        call = request.call_args
        self.assertEqual(call.args[:2], (
            'POST', 'https://playground.api.beamcheckout.com/api/v1/refunds'))
        self.assertEqual(call.kwargs['json'], {
            'chargeId': 'ch_void_test',
            'reason': 'Customer canceled',
            'amount': 4025,
        })
        self.assertEqual(call.kwargs['headers']['x-beam-idempotency-key'], 'void-idem-test')

    @patch(REQUESTS_TARGET)
    def test_pos_void_after_cutoff_requires_lighthouse(self, request):
        payment = self._original_card_payment(
            payment_date=datetime(2026, 8, 26, 12, 0),  # 19:00 Asia/Bangkok
        )
        now = datetime(2026, 8, 26, 19, 30, tzinfo=ZoneInfo('Asia/Bangkok'))

        with patch(NOW_TARGET, return_value=now):
            result = self.method.beam_create_pos_void({
                'original_payment_id': payment.id,
                'charge_id': 'ch_void_test',
                'amount_thb': 100,
                'idempotency_key': 'late-idem-test',
            })

        self.assertTrue(result['external_required'])
        self.assertEqual(result['error_code'], 'VOID_WINDOW_CLOSED')
        request.assert_not_called()

    @patch(REQUESTS_TARGET)
    def test_cutoff_recovery_reuses_the_original_idempotency_key(self, request):
        payment = self._original_card_payment(
            payment_date=datetime(2026, 8, 26, 12, 0),  # 19:00 Asia/Bangkok
        )
        request.return_value = self._response(201, {'refundId': 're_recovered'})
        now = datetime(2026, 8, 26, 19, 31, tzinfo=ZoneInfo('Asia/Bangkok'))

        with patch(NOW_TARGET, return_value=now):
            result = self.method.beam_create_pos_void({
                'original_payment_id': payment.id,
                'charge_id': 'ch_void_test',
                'amount_thb': 100,
                'idempotency_key': 'started-before-cutoff',
                'recovery': True,
            })

        self.assertEqual(result['refundId'], 're_recovered')
        self.assertEqual(
            request.call_args.kwargs['headers']['x-beam-idempotency-key'],
            'started-before-cutoff',
        )

    @patch(REQUESTS_TARGET)
    def test_successful_refund_reads_void_transaction_type(self, request):
        request.side_effect = [
            self._response(200, {'refundId': 're_void_test', 'status': 'SUCCEEDED'}),
            self._response(200, {
                'transactionId': 're_void_test',
                'transactionType': 'VOID',
            }),
        ]

        result = self.method.beam_get_refund({'refund_id': 're_void_test'})

        self.assertEqual(result['transactionType'], 'VOID')
        self.assertTrue(request.call_args.args[1].endswith('/transactions/re_void_test'))


class TestBeamQr(TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.method = cls.env['pos.payment.method'].create({
            'name': 'Beam QR Test',
            'payment_method_type': 'terminal',
            'use_payment_terminal': 'beam_qr',
            'beam_merchant_id': 'merchant_test',
            'beam_api_key': 'api_key_test',
            'beam_test_mode': True,
            'beam_expiry_sec': 120,
            'beam_payment_method_type': 'QR_PROMPT_PAY',
        })

    @staticmethod
    def _response(status_code, body=None):
        response = Mock()
        response.status_code = status_code
        response.headers = {'x-request-id': 'req_test'}
        response.text = '' if body is None else 'json'
        response.json.return_value = body
        return response

    def test_qr_method_rejects_non_qr_type(self):
        with self.assertRaises(ValidationError):
            self.method.beam_payment_method_type = 'CARD'

    @patch(REQUESTS_TARGET)
    def test_create_charge_returns_qr(self, request):
        request.return_value = self._response(201, {
            'chargeId': 'ch_qr_test',
            'status': 'PENDING',
            'actionRequired': 'ENCODED_IMAGE',
            'encodedImage': {
                'imageBase64Encoded': 'UUFCQw==',
                'expiry': '2026-08-27T12:00:00Z',
                'rawData': '000201...',
            },
        })

        result = self.method.beam_qr_create_charge({
            'amount_thb': 100.50,
            'reference_id': 'KO-test-ref',
            'idempotency_key': 'qr-idem-1',
        })

        self.assertEqual(result['charge_id'], 'ch_qr_test')
        self.assertEqual(result['qr_image_base64'], 'UUFCQw==')
        self.assertEqual(result['qr_expiry'], '2026-08-27T12:00:00Z')

        args, kwargs = request.call_args
        self.assertEqual(args[0], 'POST')
        self.assertTrue(args[1].endswith('/api/v1/charges'))
        payload = kwargs['json']
        self.assertEqual(payload['amount'], 10050)
        self.assertEqual(payload['currency'], 'THB')
        self.assertEqual(payload['referenceId'], 'KO-test-ref')
        self.assertTrue(payload['returnUrl'])
        self.assertEqual(
            payload['paymentMethod']['paymentMethodType'], 'QR_PROMPT_PAY')
        self.assertIn('expiryTime', payload['paymentMethod']['qrPromptPay'])
        self.assertEqual(
            kwargs['headers']['x-beam-idempotency-key'], 'qr-idem-1')

    @patch(REQUESTS_TARGET)
    def test_create_charge_without_qr_image_reports_charge_id(self, request):
        request.return_value = self._response(201, {
            'chargeId': 'ch_qr_no_image',
            'status': 'PENDING',
            'actionRequired': 'NONE',
        })

        result = self.method.beam_qr_create_charge({
            'amount_thb': 50,
            'reference_id': 'KO-test-ref-2',
            'idempotency_key': 'qr-idem-2',
        })

        self.assertIn('error', result)
        self.assertEqual(result['charge_id'], 'ch_qr_no_image')

    @patch(REQUESTS_TARGET)
    def test_get_charge_polls_status(self, request):
        request.return_value = self._response(200, {
            'chargeId': 'ch_qr_test',
            'status': 'SUCCEEDED',
        })

        result = self.method.beam_qr_get_charge({'charge_id': 'ch_qr_test'})

        self.assertEqual(result['status'], 'SUCCEEDED')
        args, _kwargs = request.call_args
        self.assertEqual(args[0], 'GET')
        self.assertTrue(args[1].endswith('/api/v1/charges/ch_qr_test'))

    def test_create_charge_wrong_terminal(self):
        bolt_method = self.env['pos.payment.method'].create({
            'name': 'Beam Bolt Not QR',
            'payment_method_type': 'terminal',
            'use_payment_terminal': 'beam_bolt',
            'beam_merchant_id': 'merchant_test',
            'beam_api_key': 'api_key_test',
            'beam_test_mode': True,
        })
        result = bolt_method.beam_qr_create_charge({'amount_thb': 10})
        self.assertIn('error', result)

    def test_create_charge_rejects_bad_amount(self):
        for bad_amount in (0, -5, 'abc', None):
            result = self.method.beam_qr_create_charge({'amount_thb': bad_amount})
            self.assertIn('error', result)
