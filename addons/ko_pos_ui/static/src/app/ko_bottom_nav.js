/** @odoo-module **/

import { Component } from "@odoo/owl";
import { usePos } from "@point_of_sale/app/hooks/pos_hook";

export class KoBottomNav extends Component {
    static template = "ko_pos_ui.BottomNav";
    static props = {};

    setup() {
        this.pos = usePos();
    }

    get activeTab() {
        const currentScreen = this.pos.router?.state?.current;
        if (currentScreen === "TicketScreen") {
            return "tickets";
        }
        return "sell";
    }

    goSell() {
        this.pos.mobile_pane = "right";
        if (this.pos.router?.state?.current === "ProductScreen") {
            return;
        }
        // There is very often NO current order in restaurant mode: Odoo's
        // afterOrderDeletion only re-selects one when module_pos_restaurant is
        // off, so finishing a sale or clearing an order leaves
        // `selectedOrderUuid` unset and `getOrder()` returning undefined.
        // Reading `.uuid` off that threw and the ขาย tab did nothing at all.
        const order = this.pos.getOrder();
        if (order) {
            this.pos.navigate("ProductScreen", { orderUuid: order.uuid });
        } else if (this.pos.config?.module_pos_restaurant) {
            // Nothing in hand: start where a sale starts in a restaurant —
            // the floor plan, so staff pick a table rather than being dropped
            // into a blank order (or, worse, into another table's draft).
            this.pos.navigate("FloorScreen", {});
        } else {
            const page = this.pos.defaultPage;
            this.pos.navigate(page.page, page.params);
        }
    }

    goTickets() {
        this.pos.ticket_screen_mobile_pane = "left";
        if (this.pos.router?.state?.current !== "TicketScreen") {
            this.pos.navigate("TicketScreen");
        }
    }

    goKitchen() {
        // Open the kitchen board of THIS POS, not the shop picker, so staff never
        // land on another shop's board.
        const configId = this.pos.config?.id;
        window.location.assign(configId ? `/kds/pos/${configId}` : "/kds");
    }
}
