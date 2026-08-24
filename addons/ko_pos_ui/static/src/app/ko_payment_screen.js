/** @odoo-module **/

import { onMounted, useState } from "@odoo/owl";
import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { formatCurrency } from "@web/core/currency";
import { patch } from "@web/core/utils/patch";
import { showKoToast } from "./ko_toast";

function methodType(method) {
    const name = (method?.name || "").toLowerCase();
    if (method?.type === "cash" || method?.is_cash_count || name.includes("เงินสด") || name.includes("cash")) {
        return "cash";
    }
    if (method?.payment_method_type === "qr_code" || name.includes("พร้อมเพย์") || name.includes("promptpay") || name.includes("qr")) {
        return "promptpay";
    }
    if (method?.use_payment_terminal || name.includes("บัตร") || name.includes("card")) {
        return "card";
    }
    return "other";
}

patch(PaymentScreen.prototype, {
    setup() {
        super.setup(...arguments);
        this.koState = useState({
            cashInput: "",
            selectedMethodType: this.selectedPaymentLine
                ? methodType(this.selectedPaymentLine.payment_method_id)
                : "cash",
            requesting: false,
        });
        onMounted(() => this._koEnsureDefaultMethod());
    },

    async _koEnsureDefaultMethod() {
        if (this.paymentLines.length || !this.koMethods.length) {
            return;
        }
        const defaultMethod = this.koMethods.find((item) => item.type === "cash") || this.koMethods[0];
        await this.koSelectMethod(defaultMethod.type);
    },

    get koMethods() {
        const labels = {
            cash: ["เงินสด", "Cash"],
            promptpay: ["พร้อมเพย์", "PromptPay"],
            card: ["บัตรเครดิต", "Card"],
            other: ["ช่องทางอื่น", "Other"],
        };
        return this.payment_methods_from_config.map((method) => {
            const type = methodType(method);
            return {
                type,
                key: `${type}-${method.id}`,
                name: labels[type][0],
                en: labels[type][1],
                method,
            };
        });
    },

    get koSelectedMethodType() {
        return methodType(this.selectedPaymentLine?.payment_method_id) || this.koState.selectedMethodType;
    },

    get koAmountDue() {
        return formatCurrency(Math.abs(this.currentOrder?.priceIncl || 0), this.pos.currency.id);
    },

    get koTotalAmount() {
        return formatCurrency(Math.abs(this.currentOrder?.priceIncl || 0), this.pos.currency.id);
    },

    async koSelectMethod(type) {
        const target = this.koMethods.find((item) => item.type === type)?.method;
        if (!target || this.koState.requesting) {
            showKoToast("ยังไม่ได้ตั้งค่าช่องทางชำระเงินนี้");
            return;
        }

        const blockingLine = this.paymentLines.find(
            (line) => line.isElectronic?.() && !["pending", "retry"].includes(line.getPaymentStatus())
        );
        if (blockingLine) {
            showKoToast("กรุณารอหรือยกเลิกรายการที่เครื่องรับชำระก่อน");
            return;
        }

        for (const line of [...this.paymentLines]) {
            this.deletePaymentLine(line.uuid);
        }
        if (this.paymentLines.length) {
            showKoToast("กำลังยกเลิกรายการชำระเดิม กรุณารอสักครู่");
            return;
        }

        this.koState.selectedMethodType = type;
        this.koState.cashInput = "";
        const added = await this.addNewPaymentLine(target);
        if (!added) {
            return;
        }

        const line = this.selectedPaymentLine;
        if (!line) {
            return;
        }
        if (type === "cash") {
            this.koState.cashInput = String(Math.abs(line.getAmount?.() || 0));
            return;
        }

        const needsRequest =
            target.payment_method_type === "qr_code" ||
            (target.use_payment_terminal && !target.payment_terminal?.fastPayments);
        if (needsRequest) {
            this.koState.requesting = true;
            try {
                await this.sendPaymentRequest(line);
            } finally {
                this.koState.requesting = false;
            }
        }
    },

    get koIsCash() {
        return this.koSelectedMethodType === "cash";
    },

    get koIsPromptPay() {
        return this.koSelectedMethodType === "promptpay";
    },

    get koIsCard() {
        return this.koSelectedMethodType === "card";
    },

    get koReceivedAmount() {
        return Math.abs(this.selectedPaymentLine?.getAmount?.() || Number(this.koState.cashInput) || 0);
    },

    get koFormattedReceived() {
        return formatCurrency(this.koReceivedAmount, this.pos.currency.id);
    },

    get koChangeAmount() {
        return this.isRefundOrder ? 0 : Math.max(0, this.koReceivedAmount - this.currentOrder.priceIncl);
    },

    get koHasChange() {
        return this.koIsCash && !this.pos.currency.isZero(this.koChangeAmount);
    },

    get koFormattedChange() {
        return formatCurrency(this.koChangeAmount, this.pos.currency.id);
    },

    get koCanValidate() {
        if (!this.currentOrder || this.currentOrder.isEmpty() || this.koState.requesting) {
            return false;
        }
        const line = this.selectedPaymentLine;
        if (line?.isElectronic?.()) {
            return line.getPaymentStatus() === "done" && this.currentOrder.isPaid();
        }
        return this.currentOrder.isPaid();
    },

    koSetCashAmount(amount) {
        const signedAmount = this.isRefundOrder ? -Math.abs(amount) : Math.abs(amount);
        this.koState.cashInput = String(Math.abs(amount));
        this.selectedPaymentLine?.setAmount(signedAmount);
        this.numberBuffer.set(String(signedAmount));
    },

    koQuickCash(amount) {
        const exact = Math.abs(this.currentOrder.totalDue);
        this.koSetCashAmount(amount === "exact" ? exact : Number(amount));
    },

    koNumpadPress(key) {
        if (key === "⌫") {
            this.koState.cashInput = this.koState.cashInput.slice(0, -1);
        } else if (this.koState.cashInput.length < 9) {
            this.koState.cashInput += key;
        }
        this.koSetCashAmount(Number(this.koState.cashInput || "0"));
    },

    async koValidatePayment() {
        if (!this.koCanValidate) {
            return;
        }
        try {
            // Everything that has to happen around a validated order — sending
            // it to the kitchen, and striking refunded dishes off the board —
            // hangs off OrderPaymentValidation in ko_pos_kds, not off this
            // button. Odoo's own validate button is still reachable on some
            // layouts, and behaviour must not depend on which one was pressed.
            await this.validateOrder(false);
        } catch (error) {
            console.error("KO POS payment validation failed", error);
            showKoToast("ชำระเงินไม่สำเร็จ กรุณาตรวจสอบอีกครั้ง");
        }
    },

    koBackToSell() {
        this.pos.navigate("ProductScreen", { orderUuid: this.currentOrder.uuid });
    },
});
