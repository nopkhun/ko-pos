# -*- coding: utf-8 -*-

from odoo.tests import TransactionCase, tagged


class KdsCommon(TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        Station = cls.env['ko.kds.station']
        # Start from a clean slate: the seeded stations of ko_pos_kds /
        # ko_pos_setup would otherwise decide the routing under the test.
        Station.search([]).write({'active': False})

        cls.categ_drink = cls.env['pos.category'].create({'name': 'เครื่องดื่มทดสอบ KDS'})
        cls.categ_food = cls.env['pos.category'].create({'name': 'อาหารทดสอบ KDS'})

        cls.product_drink = cls.env['product.template'].create({
            'name': 'ชาทดสอบ KDS',
            'available_in_pos': True,
            'list_price': 45,
            'pos_categ_ids': [(6, 0, cls.categ_drink.ids)],
        }).product_variant_id
        cls.product_food = cls.env['product.template'].create({
            'name': 'ข้าวผัดทดสอบ KDS',
            'available_in_pos': True,
            'list_price': 60,
            'pos_categ_ids': [(6, 0, cls.categ_food.ids)],
        }).product_variant_id
        cls.product_uncategorised = cls.env['product.template'].create({
            'name': 'ของแถมไม่มีหมวดทดสอบ KDS',
            'available_in_pos': True,
            'list_price': 0,
        }).product_variant_id

        cls.config = cls.env['pos.config'].search([], limit=1)
        if not cls.config:
            # A database installed --without-demo has no shop yet, and a routing
            # test without a POS would silently skip every per-shop rule.
            cls.config = cls.env['pos.config'].create({'name': 'KDS ทดสอบร้านหลัก'})
        cls.station_bar = Station.create({
            'name': 'บาร์น้ำทดสอบ',
            'sequence': 10,
            'category_ids': [(6, 0, cls.categ_drink.ids)],
        })
        cls.station_hot = Station.create({
            'name': 'ครัวร้อนทดสอบ',
            'sequence': 20,
            'category_ids': [(6, 0, cls.categ_food.ids)],
        })
        cls.station_catch_all = Station.create({
            'name': 'ครัวรับที่เหลือทดสอบ',
            'sequence': 99,
        })

    def _payload(self, product, order_uuid='order-kds-test', line_uuid='line-kds-test',
                 qty=1, changes_key='new', **extra):
        payload = {
            'order_uuid': order_uuid,
            'pos_reference': 'Order 0001',
            'tracking_number': '1',
            'config_id': self.config.id,
            'table': '1',
            'floor': 'หน้าร้าน',
            changes_key: [{
                'uuid': line_uuid,
                'product_id': product.id,
                'name': product.display_name,
                'quantity': qty,
                'customer_note': 'หวานน้อย',
            }],
        }
        payload.update(extra)
        return payload


@tagged('post_install', '-at_install')
class TestKdsStationRouting(KdsCommon):
    """Requirement 1 & 3: configurable stations, per shop, by category or menu."""

    def test_category_routes_to_its_station(self):
        Ticket = self.env['ko.kds.ticket']
        ticket = Ticket.browse(Ticket.create_from_pos(self._payload(self.product_drink)))
        self.assertEqual(ticket.line_ids.station_id, self.station_bar)

    def test_named_menu_item_beats_its_category(self):
        """A dish can be pulled out of its category's station by name."""
        self.station_hot.product_tmpl_ids = [(6, 0, self.product_drink.product_tmpl_id.ids)]
        Ticket = self.env['ko.kds.ticket']
        ticket = Ticket.browse(Ticket.create_from_pos(
            self._payload(self.product_drink, order_uuid='route-named', line_uuid='route-named-1')))
        self.assertEqual(ticket.line_ids.station_id, self.station_hot)

    def test_unmatched_product_falls_to_catch_all(self):
        Ticket = self.env['ko.kds.ticket']
        ticket = Ticket.browse(Ticket.create_from_pos(
            self._payload(self.product_uncategorised,
                          order_uuid='route-none', line_uuid='route-none-1')))
        self.assertEqual(ticket.line_ids.station_id, self.station_catch_all)

    def test_station_scoped_to_another_pos_is_not_used(self):
        other = self.env['pos.config'].create({'name': 'KDS ทดสอบร้านอื่น'})
        self.station_bar.config_ids = [(6, 0, other.ids)]
        Ticket = self.env['ko.kds.ticket']
        ticket = Ticket.browse(Ticket.create_from_pos(
            self._payload(self.product_drink, order_uuid='route-scope', line_uuid='route-scope-1')))
        # Not the bar (it belongs to the other shop) — the catch-all instead.
        self.assertEqual(ticket.line_ids.station_id, self.station_catch_all)

    def test_legacy_lines_get_a_station_on_migration(self):
        Ticket = self.env['ko.kds.ticket']
        ticket = Ticket.browse(Ticket.create_from_pos(
            self._payload(self.product_drink, order_uuid='route-legacy', line_uuid='route-legacy-1')))
        ticket.line_ids.station_id = False
        self.env['ko.kds.station']._ko_migrate_line_stations()
        self.assertEqual(ticket.line_ids.station_id, self.station_bar)


@tagged('post_install', '-at_install')
class TestKdsLifecycle(KdsCommon):

    def test_upsert_ready_serve_and_cancel(self):
        Ticket = self.env['ko.kds.ticket']

        ticket_id = Ticket.create_from_pos(self._payload(self.product_drink))
        ticket = Ticket.browse(ticket_id)
        self.assertEqual(ticket.line_ids.station_id, self.station_bar)
        self.assertEqual(ticket.line_ids.pos_order_line_uuid, 'line-kds-test')

        # The POS sends the line's absolute quantity, so a second send of the
        # same line replaces it rather than resetting the plate count.
        second_id = Ticket.create_from_pos(self._payload(self.product_drink, qty=3))
        self.assertEqual(second_id, ticket.id)
        self.assertEqual(len(ticket.line_ids), 1)
        self.assertEqual(ticket.line_ids.qty, 3)

        ticket.set_kds_state('ready')
        self.assertEqual(ticket.state, 'ready')
        self.assertEqual(ticket.line_ids.state, 'ready')
        status = Ticket.get_pos_status(['order-kds-test'], self.config.id)
        line_status = status['order-kds-test']['lines']['line-kds-test']
        self.assertEqual(line_status['state'], 'ready')
        self.assertEqual(line_status['station'], 'บาร์น้ำทดสอบ')
        self.assertIsNone(line_status['issue'])

        self.assertTrue(Ticket.serve_line_from_pos('order-kds-test', 'line-kds-test'))
        self.assertEqual(ticket.state, 'served')
        self.assertEqual(ticket.line_ids.state, 'served')

        self.assertTrue(Ticket.cancel_by_order_uuid('order-kds-test'))
        self.assertEqual(ticket.state, 'cancelled')
        self.assertEqual(ticket.line_ids.state, 'cancelled')

        Ticket.create_from_pos(self._payload(self.product_drink, changes_key='cancelled', qty=2))
        self.assertEqual(ticket.state, 'cancelled')
        self.assertEqual(ticket.line_ids.state, 'cancelled')

    def test_takeaway_keeps_the_customer_name_and_paid_flag(self):
        """Requirement 2: a takeaway is identified by the customer's name."""
        Ticket = self.env['ko.kds.ticket']
        ticket = Ticket.browse(Ticket.create_from_pos(self._payload(
            self.product_food,
            order_uuid='takeaway-1', line_uuid='takeaway-line-1',
            table=None, customer_name='คุณนพ', paid=True,
        )))
        self.assertEqual(ticket.order_type, 'takeaway')
        self.assertEqual(ticket.customer_name, 'คุณนพ')
        self.assertTrue(ticket.paid)

    def test_change_seq_moves_when_new_dishes_arrive(self):
        """The board uses this to beep for dishes added to an existing table."""
        Ticket = self.env['ko.kds.ticket']
        ticket = Ticket.browse(Ticket.create_from_pos(
            self._payload(self.product_food, order_uuid='seq-1', line_uuid='seq-line-1')))
        first = ticket.change_seq
        Ticket.create_from_pos(
            self._payload(self.product_drink, order_uuid='seq-1', line_uuid='seq-line-2'))
        self.assertGreater(ticket.change_seq, first)
        self.assertEqual(len(ticket.line_ids), 2)


@tagged('post_install', '-at_install')
class TestKdsIssues(KdsCommon):
    """Requirement 5: the station reports a problem, front of house is alerted."""

    def _one_line(self, order_uuid='issue-order', line_uuid='issue-line'):
        Ticket = self.env['ko.kds.ticket']
        ticket = Ticket.browse(Ticket.create_from_pos(
            self._payload(self.product_food, order_uuid=order_uuid, line_uuid=line_uuid)))
        return ticket, ticket.line_ids[0]

    def test_reported_issue_reaches_the_pos_payload_unacknowledged(self):
        ticket, line = self._one_line()
        self.assertTrue(line.report_issue('delay', 'รออีก 10 นาที'))
        status = self.env['ko.kds.ticket'].get_pos_status(['issue-order'], self.config.id)
        issue = status['issue-order']['lines']['issue-line']['issue']
        self.assertEqual(issue['type'], 'delay')
        self.assertEqual(issue['label'], 'ล่าช้า')
        self.assertEqual(issue['note'], 'รออีก 10 นาที')
        self.assertFalse(issue['ack'])

    def test_out_of_stock_stops_the_dish(self):
        ticket, line = self._one_line('oos-order', 'oos-line')
        line.report_issue('out_of_stock', 'หมดแล้ว')
        self.assertEqual(line.state, 'cancelled')
        self.assertTrue(line.cancelled)
        # Only line on the ticket, so the whole ticket closes out.
        self.assertEqual(ticket.state, 'cancelled')

    def test_front_of_house_acknowledgement_clears_the_alert(self):
        ticket, line = self._one_line('ack-order', 'ack-line')
        line.report_issue('substitute', 'ขอเปลี่ยนเป็นผัดซีอิ๊ว')
        Ticket = self.env['ko.kds.ticket']
        self.assertTrue(Ticket.ack_issues_from_pos('ack-order', ['ack-line']))
        issue = Ticket.get_pos_status(['ack-order'], self.config.id)['ack-order']['lines']['ack-line']['issue']
        self.assertTrue(issue['ack'])
        # Nothing left to acknowledge the second time round.
        self.assertFalse(Ticket.ack_issues_from_pos('ack-order', ['ack-line']))

    def test_serving_a_flagged_dish_settles_its_alert(self):
        ticket, line = self._one_line('serve-issue-order', 'serve-issue-line')
        line.report_issue('delay', 'ช้าหน่อย')
        self.env['ko.kds.ticket'].serve_line_from_pos('serve-issue-order', 'serve-issue-line')
        self.assertTrue(line.issue_ack)

    def test_unknown_issue_type_is_refused(self):
        ticket, line = self._one_line('bad-issue-order', 'bad-issue-line')
        self.assertFalse(line.report_issue('meteor_strike', ''))
        self.assertFalse(line.issue_type)


@tagged('post_install', '-at_install')
class TestKdsShopIsolation(KdsCommon):
    """Two shops must never see each other's kitchen tickets."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        configs = cls.env['pos.config'].search([], limit=2)
        while len(configs) < 2:
            configs |= cls.env['pos.config'].create({
                'name': 'KDS ทดสอบร้าน %s' % (len(configs) + 1),
            })
        cls.config_a, cls.config_b = configs[0], configs[1]

    def _iso_payload(self, config, order_uuid, line_uuid):
        return {
            'order_uuid': order_uuid,
            'pos_reference': 'Order %s' % line_uuid,
            'tracking_number': '1',
            'config_id': config.id,
            'table': '1',
            'floor': 'หน้าร้าน',
            'new': [{
                'uuid': line_uuid,
                'product_id': self.product_food.id,
                'name': self.product_food.display_name,
                'quantity': 1,
            }],
        }

    def test_tickets_are_scoped_to_their_pos(self):
        Ticket = self.env['ko.kds.ticket']
        id_a = Ticket.create_from_pos(self._iso_payload(self.config_a, 'iso-order-a', 'iso-line-a'))
        id_b = Ticket.create_from_pos(self._iso_payload(self.config_b, 'iso-order-b', 'iso-line-b'))
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
        id_a = Ticket.create_from_pos(self._iso_payload(self.config_a, shared_uuid, 'line-a'))
        id_b = Ticket.create_from_pos(self._iso_payload(self.config_b, shared_uuid, 'line-b'))
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
