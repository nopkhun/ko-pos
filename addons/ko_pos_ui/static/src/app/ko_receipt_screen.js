/** @odoo-module **/

import { ReceiptScreen } from "@point_of_sale/app/screens/receipt_screen/receipt_screen";
import { formatCurrency } from "@web/core/currency";
import { patch } from "@web/core/utils/patch";
import { showKoToast } from "./ko_toast";

patch(ReceiptScreen.prototype, {
    get koIsRefund() {
        return Boolean(this.currentOrder?.isRefund);
    },

    get koOrderNumber() {
        const name = this.currentOrder?.name || this.currentOrder?.pos_reference || "";
        const shortName = String(name).split("/").at(-1) || name;
        return shortName ? `#${shortName}` : "";
    },

    get koTotalFormatted() {
        return formatCurrency(Math.abs(this.currentOrder?.priceIncl || 0), this.pos.currency.id);
    },

    get koChangeFormatted() {
        const change = this.currentOrder?.change || 0;
        return change > 0 ? formatCurrency(change, this.pos.currency.id) : null;
    },

    get koIsEditRefund() {
        return this.koRefundIntent?.type === "edit";
    },

    get koRefundIntent() {
        const order = this.currentOrder;
        if (!order?.isRefund) {
            return null;
        }
        if (this.pos.koRefundIntent?.refundOrderUuid === order.uuid) {
            return this.pos.koRefundIntent;
        }
        try {
            return JSON.parse(
                sessionStorage.getItem(`ko_pos_refund_intent_${order.uuid}`) || "null"
            );
        } catch {
            return null;
        }
    },

    async koPrintReceipt() {
        const result = await this.pos.printReceipt({ order: this.currentOrder });
        showKoToast(result ? "ส่งพิมพ์ใบเสร็จแล้ว" : "พิมพ์ใบเสร็จไม่สำเร็จ");
    },

    /** Keep the table and the customer the original bill had. */
    _koReplacementOrderValues(intent) {
        const values = {};
        const table = intent.tableId
            ? this.pos.models["restaurant.table"]?.get(intent.tableId)
            : null;
        if (table) {
            values.table_id = table;
        }
        const partner = intent.partnerId
            ? this.pos.models["res.partner"]?.get(intent.partnerId)
            : null;
        if (partner) {
            values.partner_id = partner;
        }
        return values;
    },

    async koNewOrder() {
        const refundOrder = this.currentOrder;
        const refundOrderUuid = refundOrder?.uuid;
        const currentIntent = this.koRefundIntent;
        const intent = currentIntent?.type === "edit" ? currentIntent : null;
        const finishesRefundIntent = Boolean(refundOrder?.isRefund && currentIntent);

        // Build the replacement order explicitly, and build it BEFORE handing
        // control back to Odoo's navigation.
        //
        // The old code called `addLineToCurrentOrder` after `orderDone()`. But
        // `navigate()` only re-points `selectedOrderUuid` when the target page
        // carries an orderUuid, and in restaurant mode `orderDone()` goes to the
        // floor plan without one — so the POS was still pointing at the refund
        // order it had just finalized. `addLineToCurrentOrder` then called
        // `assertEditable()` on it and threw "Finalized Order cannot be
        // modified": the cashier refunded the bill and got nothing back.
        //
        // `createNewOrder` (not `addNewOrder`) is deliberate: it must not become
        // the selected order while the receipt screen is still on screen.
        let replacement = null;
        if (intent) {
            try {
                replacement = this.pos.createNewOrder(this._koReplacementOrderValues(intent));
                for (const item of intent.lines) {
                    const productTemplate =
                        item.productTemplate ||
                        this.pos.models["product.template"].get(item.productTemplateId);
                    if (!productTemplate) {
                        continue;
                    }
                    await this.pos.addLineToOrder(
                        {
                            product_tmpl_id: productTemplate,
                            qty: item.qty,
                            customer_note: item.customerNote,
                            payload: item.payload,
                        },
                        replacement
                    );
                }
            } catch (error) {
                console.error("KO POS could not rebuild the edited order", error);
            }
        }

        await this.pos.orderDone(refundOrder);

        if (finishesRefundIntent) {
            this.pos.koRefundIntent = null;
            try {
                sessionStorage.removeItem(`ko_pos_refund_intent_${refundOrderUuid}`);
            } catch {
                // In-memory intent still clears even if browser storage is unavailable.
            }
        }

        if (!replacement) {
            return;
        }
        if (!replacement.getOrderlines().length) {
            // Nothing came back — do not leave a blank order lying around for
            // the next person (or for the session close) to trip over.
            try {
                await this.pos.deleteOrders([replacement], [], true);
            } catch (error) {
                console.error("KO POS could not discard the empty replacement order", error);
            }
            showKoToast("โหลดรายการเดิมไม่สำเร็จ กรุณาคีย์ใหม่");
            return;
        }

        this.pos.setOrder(replacement);
        this.pos.addPendingOrder([replacement.id]);
        this.pos.mobile_pane = "right";
        this.pos.navigate("ProductScreen", { orderUuid: replacement.uuid });
        showKoToast("โหลดรายการเดิมแล้ว กรุณาแก้ไขและชำระใหม่");
    },
});
