/** @odoo-module **/

import { patch } from "@web/core/utils/patch";
import { PosStore } from "@point_of_sale/app/services/pos_store";
import { changesToOrder } from "@point_of_sale/app/models/utils/order_change";

/**
 * KO KDS: every time an order is sent to the kitchen, also create a
 * KDS ticket on the server (ko.kds.ticket) so kitchen screens can show it.
 */
patch(PosStore.prototype, {
    async setup() {
        await super.setup(...arguments);
        // Listen only to this POS's kitchen channel — another shop's kitchen
        // activity must not trigger a refresh here.
        this.bus.addChannel(`ko_pos_kds_${this.config.id}`);
        this.bus.subscribe("ko_pos_kds_update", () => this.koRefreshKdsStatus());
        await this.koRefreshKdsStatus();
    },

    async koRefreshKdsStatus() {
        const orders = this.models["pos.order"].getAll();
        if (!orders.length) {
            return;
        }
        try {
            const status = await this.data.call(
                "ko.kds.ticket",
                "get_pos_status",
                [orders.map((order) => order.uuid), this.config.id]
            );
            for (const order of orders) {
                const orderStatus = status[order.uuid];
                if (!orderStatus) {
                    continue;
                }
                for (const line of order.getOrderlines()) {
                    const status = orderStatus.lines[line.uuid];
                    const state = typeof status === "string" ? status : status?.state;
                    line.koServed = state === "served";
                    line.koKitchenState = state || null;
                    line.koKitchenStation = typeof status === "object" ? status?.station : null;
                }
            }
        } catch (error) {
            console.warn("KDS: failed refreshing front-of-house state", error);
        }
    },

    async sendOrderInPreparation(order, opts = {}) {
        let kdsPayload = null;
        try {
            if (!order.isRefund && !opts.byPassPrint && !order.uiState?.isReprinting) {
                // All POS categories: server-side stations do the filtering.
                const allCategIds = new Set(this.models["pos.category"].map((c) => c.id));
                if (allCategIds.size) {
                    const change = changesToOrder(order, allCategIds, opts.cancelled);
                    const hasChanges =
                        change.new.length ||
                        change.cancelled.length ||
                        change.internal_note ||
                        change.general_customer_note;
                    if (hasChanges) {
                        kdsPayload = {
                            order_uuid: order.uuid,
                            pos_reference: order.pos_reference,
                            tracking_number: order.tracking_number,
                            config_id: this.config.id,
                            table: order.table_id ? order.table_id.table_number : null,
                            floor: order.table_id?.floor_id?.name || "",
                            internal_note: change.internal_note || "",
                            general_customer_note: change.general_customer_note || "",
                            new: change.new,
                            cancelled: change.cancelled,
                        };
                    }
                }
            }
        } catch (e) {
            console.warn("KDS: failed computing changes", e);
        }

        if (kdsPayload) {
            // Send to KDS first — the (optional) kitchen printer may be slow/offline.
            try {
                await this.data.call("ko.kds.ticket", "create_from_pos", [kdsPayload]);
                await this.koRefreshKdsStatus();
            } catch (e) {
                // Offline or server error: kitchen printer (if any) still got the order.
                console.warn("KDS: failed sending ticket", e);
            }
        }
        return await super.sendOrderInPreparation(order, opts);
    },
});
