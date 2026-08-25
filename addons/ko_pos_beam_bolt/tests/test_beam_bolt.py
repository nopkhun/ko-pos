from unittest.mock import Mock, patch

from odoo.exceptions import UserError, ValidationError
from odoo.tests.common import TransactionCase


REQUESTS_TARGET = (
    'odoo.addons.ko_pos_beam_bolt.models.pos_payment_method.requests.request')


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
