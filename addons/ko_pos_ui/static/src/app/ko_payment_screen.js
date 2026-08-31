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

function asDate(value) {
    if (value?.toJSDate) {
        return value.toJSDate();
    }
    if (value instanceof Date) {
        return value;
    }
    if (!value) {
        return null;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function bangkokParts(value) {
    const date = asDate(value);
    if (!date) {
        return null;
    }
    return Object.fromEntries(
        new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Bangkok",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
        })
            .formatToParts(date)
            .filter((part) => part.type !== "literal")
            .map((part) => [part.type, Number(part.value)])
    );
}

function isBangkokVoidWindow(paymentDate, now = new Date()) {
    const paid = bangkokParts(paymentDate);
    const current = bangkokParts(now);
    if (!paid || !current) {
        return false;
    }
    const sameDay =
        paid.year === current.year && paid.month === current.month && paid.day === current.day;
    const paidMinutes = paid.hour * 60 + paid.minute;
    const currentMinutes = current.hour * 60 + current.minute;
    return sameDay && paidMinutes < 19 * 60 + 30 && currentMinutes < 19 * 60 + 30;
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
            cancelling: false,
            qrManualOpen: false,
            qrManualRef: "",
            qrManualConfirmed: false,
            refundConfirmed: false,
            manualReference: "",
            refundStatus: "",
        });
        onMounted(() => this._koEnsureDefaultMethod());
    },

    async _koEnsureDefaultMethod() {
        if (this.paymentLines.length || !this.koMethods.length) {
            return;
        }
        const sourceMethodId = this.koRefundSourcePayments[0]?.payment_method_id?.id;
        const defaultMethod =
            (this.isRefundOrder &&
                this.koMethods.find((item) => item.method.id === sourceMethodId)) ||
            this.koMethods.find((item) => item.type === "cash") ||
            this.koMethods[0];
        await this.koSelectMethod(defaultMethod.key);
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
                disabled: this.isRefundOrder && !this.koCanUseRefundMethod(method),
            };
        });
    },

    get koRefundSourcePayments() {
        if (!this.isRefundOrder) {
            return [];
        }
        const sourceOrders = new Map();
        for (const line of this.currentOrder?.getOrderlines?.() || []) {
            const sourceOrder = line.refunded_orderline_id?.order_id;
            if (sourceOrder) {
                sourceOrders.set(sourceOrder.uuid || sourceOrder.id, sourceOrder);
            }
        }
        const payments = [];
        const seen = new Set();
        for (const sourceOrder of sourceOrders.values()) {
            for (const payment of sourceOrder.payment_ids || []) {
                if (payment.amount <= 0 || payment.is_change) {
                    continue;
                }
                const key = payment.uuid || payment.id;
                if (!seen.has(key)) {
                    payments.push(payment);
                    seen.add(key);
                }
            }
        }
        return payments;
    },

    get koRefundSourcePayment() {
        return this.koRefundSourcePayments.length === 1 ? this.koRefundSourcePayments[0] : null;
    },

    get koRefundRoute() {
        if (!this.isRefundOrder) {
            return "sale";
        }
        const source = this.koRefundSourcePayment;
        if (!source) {
            return "blocked";
        }
        const method = source.payment_method_id;
        const type = methodType(method);
        if (type === "cash") {
            return "cash";
        }
        if (method?.use_payment_terminal === "beam_bolt") {
            if (this.selectedPaymentLine?.uiState?.beam_refund_external_required) {
                return "lighthouse";
            }
            const refundTransaction = String(this.selectedPaymentLine?.transaction_id || "");
            if (
                refundTransaction.startsWith("re_") ||
                refundTransaction.startsWith("beam-refund-idem:")
            ) {
                // A request already started before the cutoff must be reconciled,
                // never replaced by a second manual refund after 19:30.
                return "beam_void";
            }
            const beamType = method.beam_payment_method_type || "";
            if (
                beamType === "CARD" &&
                String(source.transaction_id || "").startsWith("ch_") &&
                isBangkokVoidWindow(source.payment_date)
            ) {
                return "beam_void";
            }
            return ["CARD", "CARD_INSTALLMENTS", "ALIPAY", "WECHAT_PAY"].includes(
                beamType
            )
                ? "lighthouse"
                : "manual";
        }
        return "manual";
    },

    get koRefundOriginalMethodName() {
        return this.koRefundSourcePayment?.payment_method_id?.name || "ไม่พบช่องทางต้นฉบับ";
    },

    get koRefundReferenceRequired() {
        return ["lighthouse", "manual"].includes(this.koRefundRoute);
    },

    get koRefundHelpTitle() {
        const labels = {
            beam_void: "Void บัตรผ่าน Beam ก่อน 19:30 น.",
            lighthouse: "ต้องดำเนินการใน Beam Lighthouse",
            cash: "คืนเงินสดให้ลูกค้า",
            manual: "คืนผ่านช่องทางภายนอก",
            blocked: "บิลนี้ต้องให้ผู้จัดการตรวจสอบ",
        };
        return labels[this.koRefundRoute] || "ตรวจสอบการคืนเงิน";
    },

    get koRefundHelpBody() {
        const labels = {
            beam_void:
                "เมื่อกดปุ่มด้านล่าง ระบบจะส่งคำขอ Void ไป Beam และรอผลสำเร็จก่อนบันทึก Odoo ห้ามกดซ้ำหรือปิดหน้าจอระหว่างรอ",
            lighthouse:
                "POS จะไม่ส่ง Refund ไป Beam หลัง 19:30 น. หรือกับช่องทางที่ไม่เข้าเงื่อนไข กรุณาให้ผู้จัดการคืนใน Lighthouse ก่อน แล้วกรอก Refund ID เพื่อบันทึก Odoo",
            cash:
                "ส่งมอบเงินสดตามยอดด้านบนให้ลูกค้าก่อน แล้วติ๊กยืนยัน ระบบจึงจะบันทึกรายการคืนเงิน",
            manual:
                "คืนเงินจริงด้วยช่องทางเดิมก่อน แล้วกรอกเลขอ้างอิงเพื่อบันทึกใน Odoo",
            blocked:
                "พบการชำระหลายช่องทางหรือไม่พบ payment ต้นฉบับ ห้ามเลือกเงินสดเพื่อข้ามขั้นตอน ให้ผู้จัดการคืนและกระทบยอดจากหลังบ้าน",
        };
        return labels[this.koRefundRoute] || "";
    },

    get koValidateLabel() {
        if (!this.isRefundOrder) {
            return "ยืนยันชำระเงิน · Validate";
        }
        const labels = {
            beam_void: `ส่ง Void ผ่าน Beam ${this.koAmountDue}`,
            lighthouse: `บันทึกการคืนจาก Lighthouse ${this.koAmountDue}`,
            cash: `ยืนยันว่าคืนเงินสด ${this.koAmountDue} แล้ว`,
            manual: `บันทึกการคืนเงิน ${this.koAmountDue}`,
            blocked: "ไม่สามารถคืนจาก POS ได้",
        };
        return labels[this.koRefundRoute] || "ยืนยันคืนเงิน";
    },

    koCanUseRefundMethod(method) {
        const source = this.koRefundSourcePayment;
        return Boolean(source && source.payment_method_id?.id === method?.id);
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

    async koSelectMethod(selector) {
        const methodItem = this.koMethods.find(
            (item) => item.key === selector || item.type === selector
        );
        const target = methodItem?.method;
        if (!target || this.koState.requesting) {
            showKoToast("ยังไม่ได้ตั้งค่าช่องทางชำระเงินนี้");
            return;
        }
        if (this.isRefundOrder && !this.koCanUseRefundMethod(target)) {
            showKoToast(`ต้องคืนผ่านช่องทางเดิม: ${this.koRefundOriginalMethodName}`);
            return;
        }

        const blockingLine = this.paymentLines.find(
            (line) =>
                line.payment_method_id?.payment_terminal &&
                line.isElectronic?.() &&
                !["pending", "retry"].includes(line.getPaymentStatus())
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

        this.koState.selectedMethodType = methodItem.type;
        this.koState.cashInput = "";
        this.koState.qrManualOpen = false;
        this.koState.qrManualRef = "";
        this.koState.qrManualConfirmed = false;
        const added = await this.addNewPaymentLine(target);
        if (!added) {
            return;
        }

        const line = this.selectedPaymentLine;
        if (!line) {
            return;
        }
        if (methodItem.type === "cash") {
            this.koState.cashInput = String(Math.abs(line.getAmount?.() || 0));
            return;
        }

        const needsRequest =
            (!this.isRefundOrder && target.payment_method_type === "qr_code") ||
            (!this.isRefundOrder &&
                target.use_payment_terminal &&
                !target.payment_terminal?.fastPayments);
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

    get koTerminalLine() {
        const isTerminalLine = (line) =>
            Boolean(line?.payment_method_id?.payment_terminal && line.isElectronic?.());
        const selected = this.selectedPaymentLine;
        if (isTerminalLine(selected)) {
            return selected;
        }
        return this.paymentLines.find(isTerminalLine) || null;
    },

    get koTerminalStatus() {
        return this.koTerminalLine?.getPaymentStatus?.() || "";
    },

    get koTerminalStatusText() {
        if (this.isRefundOrder) {
            if (this.koState.refundStatus === "sending") {
                return "กำลังส่งคำขอ Void ไป Beam…";
            }
            if (this.koState.refundStatus === "pending") {
                return "Beam รับคำขอแล้ว กำลังรอผล Void…";
            }
            if (this.koTerminalStatus === "done") {
                return "Beam ยืนยันการย้อนรายการสำเร็จแล้ว";
            }
            if (this.koTerminalStatus === "retry") {
                return "ยังไม่สำเร็จ กรุณาตรวจสอบข้อความด้านบนก่อนลองใหม่";
            }
        }
        const isQrDisplay =
            this.koTerminalLine?.payment_method_id?.use_payment_terminal === "beam_qr";
        const labels = {
            pending: "พร้อมส่งรายการไปเครื่องรับชำระ",
            waiting: "กำลังส่งรายการไปเครื่องรับชำระ…",
            waitingCard: isQrDisplay
                ? "รอลูกค้าสแกน QR บนจอลูกค้า…"
                : "รอลูกค้าชำระที่เครื่อง Beam Bolt…",
            waitingCancel: "กำลังยกเลิกรายการกับ Beam…",
            waitingCapture: "กำลังยืนยันผลการชำระเงิน…",
            timeout: "หมดเวลารอเครื่อง กรุณายกเลิกรายการ",
            retry: "รายการเดิมถูกยกเลิกแล้ว สามารถเลือกช่องทางใหม่ได้",
            done: "รับชำระเงินสำเร็จแล้ว",
            reversed: "ย้อนรายการชำระเงินแล้ว",
        };
        return labels[this.koTerminalStatus] || "กำลังตรวจสอบสถานะการชำระเงิน…";
    },

    get koQrPaymentData() {
        // Beam QR (payment_beam_qr) วางภาพ QR ไว้บน payment line เพื่อจอลูกค้า —
        // ร้านที่ไม่มีจอสองต้องเห็น QR เดียวกันบนจอพนักงาน จะได้หันจอให้ลูกค้าสแกน
        const hasQr = (line) => Boolean(line?.qrPaymentData?.qrCode);
        if (hasQr(this.selectedPaymentLine)) {
            return this.selectedPaymentLine.qrPaymentData;
        }
        return this.paymentLines.find(hasQr)?.qrPaymentData || null;
    },

    get koQrLine() {
        const isQrLine = (line) =>
            line?.payment_method_id?.use_payment_terminal === "beam_qr";
        if (isQrLine(this.selectedPaymentLine)) {
            return this.selectedPaymentLine;
        }
        return this.paymentLines.find(isQrLine) || null;
    },

    get koQrTerminal() {
        return this.koQrLine?.payment_method_id?.payment_terminal || null;
    },

    get koQrPaidAfterCancel() {
        // ลูกค้าโอนเข้า QR ที่ถูกยกเลิกไปแล้ว — watcher ฝั่ง beam_qr ตั้งธงนี้
        return (
            this.koQrLine?.uiState?.beam_qr_paid_after_cancel ||
            this.koQrTerminal?.paidAfterCancel?.chargeId ||
            null
        );
    },

    get koCanQrManual() {
        if (this.isRefundOrder || !this.koIsPromptPay) {
            return false;
        }
        const line = this.koQrLine;
        if (!line || !this.koQrTerminal?.manualConfirm) {
            return false;
        }
        // เปิดให้บันทึก Manual เฉพาะเมื่อรายการอัตโนมัติจบไปแล้ว (retry หลัง
        // ยกเลิก/ล้มเหลว) หรือ Beam ยืนยันว่าเงินเข้าใบที่ยกเลิกไป — ระหว่างรอ
        // สแกนปกติต้องให้ระบบยืนยันเอง (ถ้า API ล่ม ให้กดยกเลิกก่อนแล้วค่อย Manual)
        return (
            Boolean(this.koQrPaidAfterCancel) ||
            line.getPaymentStatus?.() === "retry"
        );
    },

    get koQrManualReady() {
        return (
            this.koState.qrManualConfirmed &&
            this.koState.qrManualRef.trim().length >= 4
        );
    },

    async koQrManualConfirm() {
        const line = this.koQrLine;
        if (
            !line ||
            !this.koCanQrManual ||
            !this.koQrManualReady ||
            this.koState.requesting
        ) {
            return;
        }
        this.koState.requesting = true;
        try {
            const confirmed = await this.koQrTerminal.manualConfirm(
                this.currentOrder,
                line,
                this.koState.qrManualRef.trim()
            );
            if (confirmed) {
                this.koState.qrManualOpen = false;
                this.koState.qrManualRef = "";
                this.koState.qrManualConfirmed = false;
                showKoToast("บันทึกยอดโอนแล้ว — กดยืนยันชำระเงินเพื่อปิดบิล");
            }
        } finally {
            this.koState.requesting = false;
        }
    },

    get koCanCancelTerminal() {
        if (this.isRefundOrder) {
            return false;
        }
        return ["waiting", "waitingCard", "waitingCapture", "timeout"].includes(
            this.koTerminalStatus
        );
    },

    async koCancelTerminalPayment() {
        const line = this.koTerminalLine;
        // ห้าม gate ด้วย koState.requesting: sendPaymentRequest ของ terminal ค้าง
        // await อยู่ตลอดช่วงรอลูกค้าสแกน/แตะบัตร ปุ่มยกเลิกต้องกดได้ระหว่างนั้น
        if (!line || !this.koCanCancelTerminal || this.koState.cancelling) {
            return;
        }
        this.koState.cancelling = true;
        try {
            await this.sendPaymentCancel(line);
            if (line.getPaymentStatus() === "retry") {
                showKoToast("ยกเลิกรายการแล้ว สามารถเลือกช่องทางชำระเงินใหม่ได้");
            } else {
                showKoToast("ยังยกเลิกรายการไม่ได้ ระบบจะตรวจสอบสถานะต่อ");
            }
        } finally {
            this.koState.cancelling = false;
        }
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

    get koRefundPaymentAmountReady() {
        if (!this.isRefundOrder || !this.currentOrder || !this.paymentLines.length) {
            return false;
        }
        // Odoo excludes a payment line whose terminal status is `pending` from
        // `amountPaid`. That is correct for a sale, but a manual refund route
        // deliberately does not contact the terminal. Check the signed amounts
        // directly here, then clear the terminal status immediately before the
        // manual/Lighthouse order is validated.
        const paymentTotal = this.paymentLines.reduce(
            (total, paymentLine) =>
                total + Number(paymentLine.getAmount?.() ?? paymentLine.amount ?? 0),
            0
        );
        return this.pos.currency.isZero(this.currentOrder.totalDue - paymentTotal);
    },

    get koRefundActionHint() {
        if (!this.isRefundOrder) {
            return "";
        }
        if (this.koRefundRoute === "blocked") {
            return "ให้ผู้จัดการตรวจสอบจากหลังบ้าน — POS จะไม่บันทึกรายการนี้";
        }
        if (!this.selectedPaymentLine || !this.koRefundPaymentAmountReady) {
            return "กำลังเตรียมยอดคืนให้ตรงกับบิล กรุณารอสักครู่";
        }
        if (this.koRefundRoute === "beam_void") {
            return "พร้อมส่ง Void ไป Beam";
        }
        if (this.koRefundRoute === "cash") {
            return this.koState.refundConfirmed
                ? "พร้อมบันทึก — ยืนยันแล้วว่าได้คืนเงินสด"
                : "ขั้นตอนที่ยังขาด: ติ๊กยืนยันว่าได้คืนเงินสดให้ลูกค้าแล้ว";
        }
        if (this.koState.manualReference.trim().length < 4) {
            return "ขั้นตอนที่ยังขาด: กรอก Refund ID หรือเลขอ้างอิงอย่างน้อย 4 ตัว";
        }
        return this.koState.refundConfirmed
            ? "พร้อมบันทึก — เลขอ้างอิงและการคืนเงินจริงครบแล้ว"
            : "ขั้นตอนที่ยังขาด: ติ๊กยืนยันว่าเงินจริงถูกคืนให้ลูกค้าแล้ว";
    },

    get koCanValidate() {
        if (!this.currentOrder || this.currentOrder.isEmpty() || this.koState.requesting) {
            return false;
        }
        const line = this.selectedPaymentLine;
        if (this.isRefundOrder) {
            if (!line || !this.koCanUseRefundMethod(line.payment_method_id)) {
                return false;
            }
            if (!this.koRefundPaymentAmountReady || this.koRefundRoute === "blocked") {
                return false;
            }
            if (this.koRefundRoute === "beam_void") {
                return true;
            }
            if (this.koRefundRoute === "cash") {
                return this.koState.refundConfirmed;
            }
            return (
                this.koState.refundConfirmed &&
                this.koState.manualReference.trim().length >= 4
            );
        }
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

    _koRefundIntentFor(order) {
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

    async koValidatePayment() {
        if (!this.koCanValidate) {
            return;
        }
        const order = this.currentOrder;
        const refundIntent = this._koRefundIntentFor(order);
        const line = this.selectedPaymentLine;
        if (this.isRefundOrder && this.koRefundRoute === "beam_void") {
            this.koState.requesting = true;
            this.koState.refundStatus = "sending";
            try {
                await this.sendPaymentRequest(line);
            } finally {
                this.koState.requesting = false;
            }
            if (line.getPaymentStatus?.() !== "done") {
                if (line.uiState?.beam_refund_external_required) {
                    this.koState.refundStatus = "";
                    showKoToast("รายการนี้ต้องคืนผ่าน Beam Lighthouse");
                } else if (line.uiState?.beam_refund_failed) {
                    this.koState.refundStatus = "";
                } else {
                    this.koState.refundStatus = "pending";
                }
                return;
            }
            this.koState.refundStatus = "done";
        } else if (this.isRefundOrder) {
            // Manual/Lighthouse routes record money that staff have already
            // returned. They must never trigger a negative Bolt Intent. Mark
            // the line `done` rather than clearing its status: Odoo 19's
            // isRefundInProcess() treats every terminal line whose status is
            // not exactly `done` as unfinished, even though a blank status is
            // otherwise included in amountPaid.
            line.setPaymentStatus?.("done");
            if (this.koRefundRoute === "cash") {
                line.transaction_id = `cash-refund-confirmed:${order.uuid}`;
                line.setReceiptInfo?.("ยืนยันคืนเงินสดให้ลูกค้าแล้ว");
            } else {
                const reference = this.koState.manualReference.trim();
                line.transaction_id =
                    this.koRefundRoute === "lighthouse"
                        ? `beam-lighthouse:${reference}`
                        : `manual-refund:${reference}`;
                line.payment_ref_no = reference;
                line.setReceiptInfo?.(`เลขอ้างอิงคืนเงิน: ${reference}`);
            }
        }
        try {
            await this.validateOrder(false);
        } catch (error) {
            console.error("KO POS payment validation failed", error);
            showKoToast(
                this.isRefundOrder
                    ? "บันทึกการคืนเงินไม่สำเร็จ กรุณาตรวจสอบอีกครั้ง"
                    : "ชำระเงินไม่สำเร็จ กรุณาตรวจสอบอีกครั้ง"
            );
            return;
        }

        // Odoo's PaymentScreen.validateOrder() does not return the boolean
        // result from OrderPaymentValidation. A rejected validation therefore
        // resolves silently. Do not clear the protected refund intent or imply
        // success unless finalizeValidation actually moved the order to paid.
        if (order.state !== "paid" && !order.finalized) {
            showKoToast(
                this.isRefundOrder
                    ? "ยังบันทึกการคืนเงินไม่สำเร็จ กรุณาตรวจสอบข้อมูลแล้วกดอีกครั้ง"
                    : "ยังบันทึกการชำระเงินไม่สำเร็จ กรุณาตรวจสอบข้อมูลแล้วกดอีกครั้ง"
            );
            return;
        }

        // Striking the refunded dishes off the kitchen board is NOT done here.
        // It hangs off OrderPaymentValidation in ko_pos_kds
        // (koCancelKitchenForRefund), because the KO payment screen only
        // replaces part of Odoo's template: on a wide screen the till validates
        // through Odoo's own button and nothing wired to a KO handler would run.
        // Doing it there also cancels exactly the refunded quantities, so
        // refunding one plate out of four leaves the other three cooking.

        // An intent that is not an "edit" has nothing left to do. Leaving it in
        // place makes the receipt screen offer to reload lines that were never
        // meant to come back.
        if (refundIntent && refundIntent.type !== "edit") {
            this.pos.koRefundIntent = null;
            try {
                sessionStorage.removeItem(`ko_pos_refund_intent_${order.uuid}`);
            } catch {
                // Storage being unavailable is not a reason to fail the refund.
            }
        }

        try {
            await this.pos.koRefreshKdsStatus?.();
        } catch (error) {
            console.warn("KO KDS refresh after refund failed", error);
        }
    },

    koBackToSell() {
        if (this.isRefundOrder && this.koState.requesting) {
            showKoToast("กำลังรอผล Void จาก Beam กรุณาอย่าปิดหน้าจอ");
            return;
        }
        if (this.koCanCancelTerminal || this.koTerminalStatus === "waitingCancel") {
            showKoToast("กรุณายกเลิกรายการที่เครื่องรับชำระก่อนกลับหน้าขาย");
            return;
        }
        this.pos.navigate("ProductScreen", { orderUuid: this.currentOrder.uuid });
    },
});
