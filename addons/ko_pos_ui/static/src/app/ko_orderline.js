/** @odoo-module **/

import { Orderline } from "@point_of_sale/app/components/orderline/orderline";
import { patch } from "@web/core/utils/patch";

patch(Orderline.prototype, {
    get koShowQuantityStepper() {
        return (
            this.props.mode === "display" &&
            this.env.services.pos?.router?.state.current === "ProductScreen" &&
            !this.line.combo_parent_id &&
            this.line.getQuantity() > 0
        );
    },

    koChangeQuantity(event, delta) {
        event.stopPropagation();
        const line = this.line;
        const order = line.order_id;
        order.assertEditable();

        const nextQuantity = line.getQuantity() + delta;
        if (nextQuantity <= 0) {
            order.removeOrderline(line);
        } else {
            line.setQuantity(nextQuantity, Boolean(line.combo_line_ids?.length));
        }
    },
});
