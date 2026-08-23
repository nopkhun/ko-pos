# -*- coding: utf-8 -*-

from odoo.tests import TransactionCase, tagged


@tagged('post_install', '-at_install')
class TestKdsLifecycle(TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.category = cls.env['pos.category'].create({
            'name': 'เครื่องดื่มทดสอบ KDS',
            'ko_kds_station': 'drink',
        })
        cls.product = cls.env['product.template'].create({
            'name': 'ชาทดสอบ KDS',
            'available_in_pos': True,
            'list_price': 45,
            'pos_categ_ids': [(6, 0, cls.category.ids)],
        }).product_variant_id

    def _payload(self, changes_key='new', qty=1):
        return {
            'order_uuid': 'order-kds-test',
            'pos_reference': 'Order 0001',
            'tracking_number': '1',
            'config_id': False,
            'table': '1',
            'floor': 'หน้าร้าน',
            changes_key: [{
                'uuid': 'line-kds-test',
                'product_id': self.product.id,
                'name': self.product.display_name,
                'quantity': qty,
                'customer_note': 'หวานน้อย',
            }],
        }

    def test_upsert_ready_serve_and_cancel(self):
        Ticket = self.env['ko.kds.ticket']

        ticket_id = Ticket.create_from_pos(self._payload())
        ticket = Ticket.browse(ticket_id)
        self.assertEqual(ticket.line_ids.station, 'drink')
        self.assertEqual(ticket.line_ids.pos_order_line_uuid, 'line-kds-test')

        second_id = Ticket.create_from_pos(self._payload(qty=2))
        self.assertEqual(second_id, ticket.id)
        self.assertEqual(len(ticket.line_ids), 1)
        self.assertEqual(ticket.line_ids.qty, 2)

        ticket.set_kds_state('ready')
        self.assertEqual(ticket.state, 'ready')
        self.assertEqual(ticket.line_ids.state, 'ready')
        status = Ticket.get_pos_status(['order-kds-test'])
        self.assertEqual(status['order-kds-test']['lines']['line-kds-test'], {
            'state': 'ready',
            'station': 'drink',
        })

        self.assertTrue(Ticket.serve_line_from_pos('order-kds-test', 'line-kds-test'))
        self.assertEqual(ticket.state, 'served')
        self.assertEqual(ticket.line_ids.state, 'served')

        self.assertTrue(Ticket.cancel_by_order_uuid('order-kds-test'))
        self.assertEqual(ticket.state, 'cancelled')
        self.assertEqual(ticket.line_ids.state, 'cancelled')

        Ticket.create_from_pos(self._payload(changes_key='cancelled', qty=2))
        self.assertEqual(ticket.state, 'cancelled')
        self.assertEqual(ticket.line_ids.state, 'cancelled')
