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

    async koPrintReceipt() {
        const result = await this.pos.printReceipt({ order: this.currentOrder });
        showKoToast(result ? "ส่งพิมพ์ใบเสร็จแล้ว" : "พิมพ์ใบเสร็จไม่สำเร็จ");
    },

    async koNewOrder() {
        // Refunding used to hide a second job here: it re-added every line of
        // the refunded bill to a fresh order so staff could "edit" it. That
        // fired the whole order at the kitchen a second time, so a customer who
        // swapped one dish got everything cooked twice. Refunds are now done
        // per line from the bill sheet, and this button just closes the sale.
        await this.pos.orderDone(this.currentOrder);
    },
});
