import { _t } from "@web/core/l10n/translation";
import { PaymentInterface } from "@point_of_sale/app/utils/payment/payment_interface";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { register_payment_method } from "@point_of_sale/app/services/pos_store";

const POLL_INTERVAL_MS = 2500;

export class PaymentBeamBolt extends PaymentInterface {
    setup() {
        super.setup(...arguments);
        this.pollingTimeout = null;
        this.cancelled = false;
    }

    pendingLine() {
        return this.pos.getPendingPaymentLine("beam_bolt");
    }

    async sendPaymentRequest(cid) {
        await super.sendPaymentRequest(cid);
        const order = this.pos.getOrder();
        const line = order.getSelectedPaymentline();
        this.cancelled = false;

        if (line.amount <= 0) {
            this._showError(_t("Beam Bolt+ ยังไม่รองรับการคืนเงินจาก POS — กรุณาคืนเงินผ่าน Beam dashboard"));
            line.setPaymentStatus("retry");
            return false;
        }

        const referenceId = (order.pos_reference || "POS").replace(/[^A-Za-z0-9]/g, "") +
            "-" + Date.now().toString(36);
        line.setPaymentStatus("waitingCard");

        const response = await this._callBeam("beam_create_bolt_intent", {
            amount_thb: line.amount,
            reference_id: referenceId,
            note: order.pos_reference || "POS order",
        });
        if (!response || response.error) {
            this._showError(response?.error || _t("สร้างรายการชำระเงินบน Bolt+ ไม่สำเร็จ"));
            line.setPaymentStatus("retry");
            return false;
        }
        const intentId = response.id || response.boltIntentId;
        if (!intentId) {
            this._showError(_t("Beam ไม่ส่ง bolt intent id กลับมา"));
            line.setPaymentStatus("retry");
            return false;
        }
        line.uiState = line.uiState || {};
        line.uiState.beam_bolt_intent_id = intentId;
        line.transaction_id = intentId;

        return await this._pollUntilResolved(line, intentId);
    }

    async sendPaymentCancel(order, cid) {
        await super.sendPaymentCancel(order, cid);
        this.cancelled = true;
        clearTimeout(this.pollingTimeout);
        const line = this.pendingLine();
        const intentId = line?.uiState?.beam_bolt_intent_id;
        if (intentId) {
            await this._callBeam("beam_cancel_bolt_intent", { bolt_intent_id: intentId });
        }
        return true;
    }

    _callBeam(method, data) {
        return this.env.services.orm.silent
            .call("pos.payment.method", method, [[this.payment_method_id.id], data])
            .catch(() => {
                return { error: _t("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ต") };
            });
    }

    _pollUntilResolved(line, intentId) {
        return new Promise((resolve) => {
            const poll = async () => {
                clearTimeout(this.pollingTimeout);
                if (this.cancelled || line.payment_status === "retry") {
                    return resolve(false);
                }
                const res = await this._callBeam("beam_get_bolt_intent", {
                    bolt_intent_id: intentId,
                });
                if (res && !res.error) {
                    const result = res.result || "";
                    const status = (res.status || "").toUpperCase();
                    if (result === "CH_SUCCEEDED" || status === "PAID") {
                        line.transaction_id = res.latestChargeId || intentId;
                        line.setPaymentStatus("done");
                        return resolve(true);
                    }
                    if (["BI_EXPIRED", "BI_CANCELED"].includes(result) ||
                        ["EXPIRED", "CANCELED"].includes(status)) {
                        this._showError(
                            result === "BI_EXPIRED" || status === "EXPIRED"
                                ? _t("หมดเวลาชำระเงินบนเครื่อง Bolt+")
                                : _t("รายการถูกยกเลิก")
                        );
                        line.setPaymentStatus("retry");
                        return resolve(false);
                    }
                    if (result && result.startsWith("CH_")) {
                        // CH_PROCESSING_FAILED / CH_INSUFFICIENT_FUNDS / CH_AUTHENTICATION_FAILED
                        const msgs = {
                            CH_PROCESSING_FAILED: _t("การประมวลผลชำระเงินล้มเหลว"),
                            CH_INSUFFICIENT_FUNDS: _t("ยอดเงินในบัตร/บัญชีไม่พอ"),
                            CH_AUTHENTICATION_FAILED: _t("ยืนยันตัวตนไม่สำเร็จ"),
                        };
                        this._showError(msgs[result] || _t("ชำระเงินไม่สำเร็จ (%s)", result));
                        line.setPaymentStatus("retry");
                        return resolve(false);
                    }
                }
                // still pending (or transient error) — keep polling while on payment screen
                if (this.pos.router?.state?.current && this.pos.router.state.current !== "PaymentScreen") {
                    return resolve(false);
                }
                this.pollingTimeout = setTimeout(poll, POLL_INTERVAL_MS);
            };
            poll();
        });
    }

    _showError(msg) {
        this.env.services.dialog.add(AlertDialog, {
            title: _t("Beam Bolt+"),
            body: msg,
        });
    }
}

register_payment_method("beam_bolt", PaymentBeamBolt);
