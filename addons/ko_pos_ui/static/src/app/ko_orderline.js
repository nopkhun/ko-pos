/** @odoo-module **/

import { Orderline } from "@point_of_sale/app/components/orderline/orderline";
import { patch } from "@web/core/utils/patch";
import { openKoItemOptions } from "./ko_item_options_sheet";

patch(Orderline.prototype, {
    get koShowQuantityStepper() {
        return (
            this.props.mode === "display" &&
            this.env.services.pos?.router?.state.current === "ProductScreen" &&
            !this.line.combo_parent_id &&
            this.line.getQuantity() > 0
        );
    },

    get koHasEditableOptions() {
        return Boolean(
            this.koShowQuantityStepper &&
                this.line.product_id?.product_tmpl_id?.isConfigurable?.() &&
                !this.line.product_id?.product_tmpl_id?.isCombo?.()
        );
    },

    koEditOptions(event) {
        event.stopPropagation();
        openKoItemOptions(this.line.product_id.product_tmpl_id, this.line);
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
