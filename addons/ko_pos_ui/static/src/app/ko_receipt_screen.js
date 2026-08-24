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

    async koNewOrder() {
        const refundOrderUuid = this.currentOrder?.uuid;
        const currentIntent = this.koRefundIntent;
        const intent = currentIntent?.type === "edit" ? currentIntent : null;
        const finishesRefundIntent = Boolean(this.currentOrder?.isRefund && currentIntent);
        await this.pos.orderDone(this.currentOrder);
        if (finishesRefundIntent) {
            this.pos.koRefundIntent = null;
            try {
                sessionStorage.removeItem(`ko_pos_refund_intent_${refundOrderUuid}`);
            } catch {
                // In-memory intent still clears even if browser storage is unavailable.
            }
        }
        if (!intent) {
            return;
        }

        for (const item of intent.lines) {
            const productTemplate =
                item.productTemplate ||
                this.pos.models["product.template"].get(item.productTemplateId);
            if (!productTemplate) {
                continue;
            }
            await this.pos.addLineToCurrentOrder({
                product_tmpl_id: productTemplate,
                qty: item.qty,
                customer_note: item.customerNote,
                payload: item.payload,
            });
        }
        // Same trap as the bottom nav: with no line restored (an empty intent)
        // there may be no current order, and getOrder() returns undefined.
        const editOrder = this.pos.getOrder();
        if (editOrder) {
            this.pos.navigate("ProductScreen", { orderUuid: editOrder.uuid });
        } else {
            const page = this.pos.defaultPage;
            this.pos.navigate(page.page, page.params);
        }
        showKoToast("โหลดรายการเดิมแล้ว กรุณาแก้ไขและชำระใหม่");
    },
});
