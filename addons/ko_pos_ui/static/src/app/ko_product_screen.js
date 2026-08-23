/** @odoo-module **/

import { useState } from "@odoo/owl";
import { ProductScreen } from "@point_of_sale/app/screens/product_screen/product_screen";
import { patch } from "@web/core/utils/patch";
import {
    KoItemOptionsSheet,
    closeKoItemOptions,
    koItemOptionsState,
    openKoItemOptions,
} from "./ko_item_options_sheet";
import { KoBottomNav } from "./ko_bottom_nav";

patch(ProductScreen, {
    components: {
        ...ProductScreen.components,
        KoItemOptionsSheet,
        KoBottomNav,
    },
});

patch(ProductScreen.prototype, {
    setup() {
        super.setup(...arguments);
        this.state.koSearchOpen = false;
        this.koItemOptionsState = useState(koItemOptionsState);
    },

    koToggleSearch() {
        this.state.koSearchOpen = !this.state.koSearchOpen;
        if (!this.state.koSearchOpen) {
            this.pos.searchProductWord = "";
        }
    },

    koUpdateSearch(event) {
        this.pos.searchProductWord = event.target.value;
    },

    koOpenOptions(product, line = null) {
        openKoItemOptions(product, line);
    },

    koCloseOptions() {
        closeKoItemOptions();
    },

    get koTableNumber() {
        return this.currentOrder?.table_id?.table_number || "";
    },

    get koDirectSaleName() {
        if (this.currentOrder?.isDirectSale) {
            return "ขายหน้าเคาน์เตอร์";
        }
        return this.currentOrder?.preset_id?.name || this.pos.config?.name || "ขายหน้าร้าน";
    },

    get koSeatCount() {
        return (
            this.currentOrder?.getCustomerCount?.() || this.currentOrder?.table_id?.seats || 0
        );
    },

    get koSessionNumber() {
        const session = this.currentOrder?.session_id || this.pos.session;
        const sessionName = session?.name || session?.display_name;
        if (sessionName) {
            const shortName = String(sessionName).split("/").at(-1);
            if (shortName) {
                return shortName;
            }
        }
        const sessionId = session?.id || globalThis.odoo?.pos_session_id;
        return sessionId ? String(sessionId).padStart(4, "0") : "-";
    },

    get koCartItemCount() {
        return this.currentOrder?.getOrderlines?.().reduce((sum, line) => sum + line.qty, 0) || 0;
    },

    get koCartTax() {
        const order = this.currentOrder;
        return this.env.utils.formatCurrency((order?.priceIncl || 0) - (order?.priceExcl || 0));
    },

    get koCartTotal() {
        return this.env.utils.formatCurrency(this.currentOrder?.priceIncl || 0);
    },
});
