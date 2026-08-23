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


@tagged('post_install', '-at_install')
class TestKdsShopIsolation(TransactionCase):
    """Two shops must never see each other's kitchen tickets."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.category = cls.env['pos.category'].create({
            'name': 'อาหารทดสอบแยกร้าน',
            'ko_kds_station': 'hot',
        })
        cls.product = cls.env['product.template'].create({
            'name': 'ข้าวผัดทดสอบแยกร้าน',
            'available_in_pos': True,
            'list_price': 60,
            'pos_categ_ids': [(6, 0, cls.category.ids)],
        }).product_variant_id
        configs = cls.env['pos.config'].search([], limit=2)
        while len(configs) < 2:
            configs |= cls.env['pos.config'].create({
                'name': 'KDS ทดสอบร้าน %s' % (len(configs) + 1),
            })
        cls.config_a, cls.config_b = configs[0], configs[1]

    def _payload(self, config, order_uuid, line_uuid):
        return {
            'order_uuid': order_uuid,
            'pos_reference': 'Order %s' % line_uuid,
            'tracking_number': '1',
            'config_id': config.id,
            'table': '1',
            'floor': 'หน้าร้าน',
            'new': [{
                'uuid': line_uuid,
                'product_id': self.product.id,
                'name': self.product.display_name,
                'quantity': 1,
            }],
        }

    def test_tickets_are_scoped_to_their_pos(self):
        Ticket = self.env['ko.kds.ticket']
        id_a = Ticket.create_from_pos(self._payload(self.config_a, 'iso-order-a', 'iso-line-a'))
        id_b = Ticket.create_from_pos(self._payload(self.config_b, 'iso-order-b', 'iso-line-b'))
        ticket_a, ticket_b = Ticket.browse(id_a), Ticket.browse(id_b)

        self.assertNotEqual(id_a, id_b)
        self.assertEqual(ticket_a.config_id, self.config_a)
        self.assertEqual(ticket_a.company_id, self.config_a.company_id)
        self.assertEqual(ticket_b.company_id, self.config_b.company_id)
        self.assertEqual(ticket_a.line_ids.company_id, self.config_a.company_id)

        # What the kitchen board actually queries.
        board_a = Ticket.search([
            ('config_id', '=', self.config_a.id),
            ('state', 'in', ['new', 'progress', 'ready']),
        ])
        self.assertIn(ticket_a, board_a)
        self.assertNotIn(ticket_b, board_a)

    def test_same_order_uuid_in_two_shops_does_not_merge(self):
        """A UUID collision across shops must not fold two orders into one ticket."""
        Ticket = self.env['ko.kds.ticket']
        shared_uuid = 'iso-shared-uuid'
        id_a = Ticket.create_from_pos(self._payload(self.config_a, shared_uuid, 'line-a'))
        id_b = Ticket.create_from_pos(self._payload(self.config_b, shared_uuid, 'line-b'))
        self.assertNotEqual(id_a, id_b)
        self.assertEqual(Ticket.browse(id_a).config_id, self.config_a)
        self.assertEqual(Ticket.browse(id_b).config_id, self.config_b)

    def test_bus_channel_is_per_pos(self):
        from odoo.addons.ko_pos_kds.models.kds import kds_channel
        self.assertEqual(kds_channel(self.config_a.id), 'ko_pos_kds_%s' % self.config_a.id)
        self.assertNotEqual(kds_channel(self.config_a.id), kds_channel(self.config_b.id))

    def test_station_availability_follows_its_pos(self):
        Station = self.env['ko.kds.station']
        shared = Station.create({'name': 'ครัวกลางทดสอบ'})
        only_a = Station.create({'name': 'ครัวร้าน A', 'config_ids': [(6, 0, self.config_a.ids)]})
        stations = shared | only_a
        self.assertEqual(stations._available_for_config(self.config_a), stations)
        self.assertEqual(stations._available_for_config(self.config_b), shared)
