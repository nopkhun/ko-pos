# -*- coding: utf-8 -*-

from odoo.tests import tagged

from .test_kds import KdsCommon


@tagged('post_install', '-at_install')
class TestKdsRefunds(KdsCommon):
    """A refund has to reach the kitchen, and only for what came back."""

    def _two_dish_ticket(self):
        Ticket = self.env['ko.kds.ticket']
        payload = self._payload(self.product_food, order_uuid='order-refund-test',
                                line_uuid='line-food', qty=2)
        payload['new'].append({
            'uuid': 'line-drink',
            'product_id': self.product_drink.id,
            'name': self.product_drink.display_name,
            'quantity': 1,
        })
        return Ticket.browse(Ticket.create_from_pos(payload))

    def test_refunding_one_dish_leaves_the_rest_cooking(self):
        ticket = self._two_dish_ticket()
        touched = self.env['ko.kds.ticket'].cancel_lines_from_pos(
            'order-refund-test', [{'uuid': 'line-drink', 'qty': 1}], self.config.id)
        self.assertEqual(touched, 1)
        drink = ticket.line_ids.filtered(lambda l: l.pos_order_line_uuid == 'line-drink')
        food = ticket.line_ids.filtered(lambda l: l.pos_order_line_uuid == 'line-food')
        self.assertTrue(drink.cancelled)
        self.assertEqual(drink.state, 'cancelled')
        self.assertFalse(food.cancelled, 'the dish that was not refunded must keep cooking')
        self.assertNotEqual(ticket.state, 'cancelled')

    def test_refunding_part_of_a_line_only_reduces_it(self):
        ticket = self._two_dish_ticket()
        self.env['ko.kds.ticket'].cancel_lines_from_pos(
            'order-refund-test', [{'uuid': 'line-food', 'qty': 1}], self.config.id)
        food = ticket.line_ids.filtered(lambda l: l.pos_order_line_uuid == 'line-food')
        self.assertFalse(food.cancelled)
        self.assertEqual(food.qty, 1, 'one of the two plates was returned, one stays')

    def test_refunding_everything_closes_the_ticket(self):
        ticket = self._two_dish_ticket()
        self.env['ko.kds.ticket'].cancel_lines_from_pos('order-refund-test', [
            {'uuid': 'line-food', 'qty': 2},
            {'uuid': 'line-drink', 'qty': 1},
        ], self.config.id)
        self.assertTrue(all(line.cancelled for line in ticket.line_ids))
        self.assertEqual(ticket.state, 'cancelled')

    def test_no_lines_given_means_the_whole_bill_came_back(self):
        ticket = self._two_dish_ticket()
        self.env['ko.kds.ticket'].cancel_lines_from_pos('order-refund-test')
        self.assertTrue(all(line.cancelled for line in ticket.line_ids))
        self.assertEqual(ticket.state, 'cancelled')

    def test_another_shops_ticket_is_never_touched(self):
        self._two_dish_ticket()
        other_config = self.env['pos.config'].create({'name': 'KDS ทดสอบร้านที่สอง'})
        Ticket = self.env['ko.kds.ticket']
        other = Ticket.browse(Ticket.create_from_pos(dict(
            self._payload(self.product_food, order_uuid='order-refund-test',
                          line_uuid='line-food', qty=2),
            config_id=other_config.id,
        )))
        Ticket.cancel_lines_from_pos('order-refund-test', None, self.config.id)
        self.assertNotEqual(other.state, 'cancelled')
        self.assertFalse(any(line.cancelled for line in other.line_ids))

    def test_unknown_order_is_a_quiet_no_op(self):
        self.assertEqual(
            self.env['ko.kds.ticket'].cancel_lines_from_pos('order-that-never-existed'), 0)
