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
        if (this.pos.router?.state?.current !== "ProductScreen") {
            this.pos.navigate("ProductScreen", { orderUuid: this.pos.getOrder().uuid });
        }
    }

    goTickets() {
        this.pos.ticket_screen_mobile_pane = "left";
        if (this.pos.router?.state?.current !== "TicketScreen") {
            this.pos.navigate("TicketScreen");
        }
    }

    goKitchen() {
        window.location.assign("/kds");
    }
}
