/** @odoo-module **/

import { ProductScreen } from "@point_of_sale/app/screens/product_screen/product_screen";
import { patch } from "@web/core/utils/patch";

patch(ProductScreen.prototype, {
    setup() {
        super.setup(...arguments);
        this.state.koSearchOpen = false;
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

    get koTableNumber() {
        return this.currentOrder?.table_id?.table_number || "";
    },

    get koDirectSaleName() {
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
            return String(sessionName).split("/").at(-1);
        }
        return session?.id || "-";
    },
});
