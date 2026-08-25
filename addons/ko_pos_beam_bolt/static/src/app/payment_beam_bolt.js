import { _t } from "@web/core/l10n/translation";
import { PaymentInterface } from "@point_of_sale/app/utils/payment/payment_interface";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { register_payment_method } from "@point_of_sale/app/services/pos_store";

const POLL_INTERVAL_MS = 2500;
const MAX_POLL_INTERVAL_MS = 15000;
const DEVICE_READY_DELAY_MS = 5000;

function makeIdempotencyKey() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }
    return `ko-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function paymentLine(order, uuid) {
    return order?.payment_ids?.find((line) => line.uuid === uuid) || order?.getSelectedPaymentline();
}

function isBoltIntentId(value) {
    return typeof value === "string" && value.startsWith("bolti_");
}

function idempotencyFromLine(line) {
    const value = line?.transaction_id || "";
    return value.startsWith("beam-idem:") ? value.slice("beam-idem:".length) : null;
}

export class PaymentBeamBolt extends PaymentInterface {
    setup() {
        super.setup(...arguments);
        this.pollingTimeout = null;
        this.pollingResolve = null;
        this.cancelled = false;
        this.activeIntentId = null;
        this.activeLineUuid = null;
    }

    pendingLine() {
        return this.pos.getPendingPaymentLine("beam_bolt");
    }

    async sendPaymentRequest(uuid) {
        await super.sendPaymentRequest(...arguments);
        const order = this.pos.getOrder();
        const line = paymentLine(order, uuid);
        this.cancelled = false;

        if (!line) {
            this._showError(_t("ไม่พบรายการชำระเงิน Beam Bolt+"));
            return false;
        }
        if (line.amount <= 0) {
            this._showError(
                _t("Beam Bolt+ ยังไม่รองรับการคืนเงินจาก POS — กรุณาคืนเงินผ่าน Beam Lighthouse")
            );
            return false;
        }

        line.uiState = line.uiState || {};
        const existingIntentId = isBoltIntentId(line.transaction_id)
            ? line.transaction_id
            : line.uiState.beam_bolt_intent_id;
        if (existingIntentId) {
            line.setPaymentStatus("waitingCard");
            return await this._pollUntilResolved(line, existingIntentId);
        }

        const retryAfter = line.uiState.beam_retry_after || 0;
        if (retryAfter > Date.now()) {
            await new Promise((resolve) => setTimeout(resolve, retryAfter - Date.now()));
        }

        const idempotencyKey =
            line.uiState.beam_bolt_idempotency_key ||
            idempotencyFromLine(line) ||
            makeIdempotencyKey();
        line.uiState.beam_bolt_idempotency_key = idempotencyKey;
        // Persist the key in Odoo's standard transaction field. If the create request
        // times out, Retry can safely repeat the same POST instead of double-charging.
        line.transaction_id = `beam-idem:${idempotencyKey}`;
        line.setPaymentStatus("waitingCard");

        const response = await this._callBeam(
            "beam_create_bolt_intent",
            this._createIntentData(order, line, idempotencyKey)
        );
        if (!response || response.error) {
            this._showError(response?.error || _t("สร้างรายการชำระเงินบน Bolt+ ไม่สำเร็จ"));
            if (!response?.retryable) {
                line.transaction_id = "";
                delete line.uiState.beam_bolt_idempotency_key;
            }
            return false;
        }
        const intentId = response.id || response.boltIntentId;
        if (!intentId) {
            this._showError(
                _t("Beam ไม่ส่ง Bolt Intent ID กลับมา กรุณาอย่าสร้างรายการใหม่และตรวจสอบ Lighthouse")
            );
            return false;
        }
        line.uiState.beam_bolt_intent_id = intentId;
        line.transaction_id = intentId;

        return await this._pollUntilResolved(line, intentId);
    }

    async sendPaymentCancel(order, uuid) {
        await super.sendPaymentCancel(...arguments);
        const line = paymentLine(order, uuid) || this.pendingLine();
        if (!line) {
            return true;
        }
        line.uiState = line.uiState || {};
        let intentId = line.uiState.beam_bolt_intent_id;
        if (!intentId && isBoltIntentId(line.transaction_id)) {
            intentId = line.transaction_id;
        }

        // A timed-out create may have succeeded at Beam without returning its ID.
        // Repeat it with the same idempotency key to recover the authoritative intent.
        const uncertainKey = idempotencyFromLine(line);
        if (!intentId && uncertainKey) {
            const recovered = await this._callBeam(
                "beam_create_bolt_intent",
                this._createIntentData(order, line, uncertainKey)
            );
            if (!recovered || recovered.error) {
                this._showError(
                    _t("ยังยืนยันไม่ได้ว่ารายการถูกสร้างหรือไม่ กรุณาตรวจสอบอินเทอร์เน็ตแล้วกดยกเลิกอีกครั้ง")
                );
                return false;
            }
            intentId = recovered.id || recovered.boltIntentId;
        }

        if (intentId) {
            const result = await this._callBeam("beam_cancel_bolt_intent", {
                bolt_intent_id: intentId,
                idempotency_key: makeIdempotencyKey(),
            });
            if (result?.error && result.status_code !== 404) {
                this._showError(
                    _t("ยกเลิกรายการบน Beam ไม่สำเร็จ กรุณาอย่ารับชำระรายการใหม่จนกว่าจะยกเลิกได้")
                );
                return false;
            }
        }

        this.cancelled = true;
        this._finishPolling(false);
        line.transaction_id = "";
        delete line.uiState.beam_bolt_intent_id;
        delete line.uiState.beam_bolt_idempotency_key;
        line.uiState.beam_retry_after = Date.now() + DEVICE_READY_DELAY_MS;
        return true;
    }

    close() {
        const intentId = this.activeIntentId;
        this.cancelled = true;
        this._finishPolling(false);
        if (intentId) {
            this._callBeam("beam_cancel_bolt_intent", {
                bolt_intent_id: intentId,
                idempotency_key: makeIdempotencyKey(),
            });
        }
    }

    _createIntentData(order, line, idempotencyKey) {
        const referenceId = `KO-${order.uuid || "order"}-${line.uuid || "payment"}`
            .replace(/[^A-Za-z0-9_-]/g, "")
            .slice(0, 100);
        return {
            amount_thb: line.amount,
            reference_id: referenceId,
            note: order.pos_reference || order.name || "POS order",
            idempotency_key: idempotencyKey,
        };
    }

    _callBeam(method, data) {
        return this.env.services.orm.silent
            .call("pos.payment.method", method, [[this.payment_method_id.id], data])
            .catch(() => {
                return {
                    error: _t("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ต"),
                    retryable: true,
                };
            });
    }

    _pollUntilResolved(line, intentId) {
        this._finishPolling(false);
        this.cancelled = false;
        this.activeIntentId = intentId;
        this.activeLineUuid = line.uuid;

        return new Promise((resolve) => {
            this.pollingResolve = resolve;
            let consecutiveErrors = 0;
            let errorShown = false;

            const poll = async () => {
                clearTimeout(this.pollingTimeout);
                if (this.cancelled || line.payment_status === "retry") {
                    return this._finishPolling(false);
                }
                const response = await this._callBeam("beam_get_bolt_intent", {
                    bolt_intent_id: intentId,
                });
                if (response?.error) {
                    consecutiveErrors += 1;
                    if (consecutiveErrors >= 3 && !errorShown) {
                        errorShown = true;
                        this._showError(
                            _t("ยังตรวจสอบผลจาก Beam ไม่ได้ ระบบจะลองต่ออัตโนมัติ กรุณาอย่าสร้างรายการชำระใหม่")
                        );
                    }
                    const retryDelay = Math.min(
                        POLL_INTERVAL_MS * 2 ** Math.min(consecutiveErrors, 3),
                        MAX_POLL_INTERVAL_MS
                    );
                    this.pollingTimeout = setTimeout(poll, retryDelay);
                    return;
                }

                consecutiveErrors = 0;
                const result = (response?.result || "").toUpperCase();
                const status = (response?.status || "").toUpperCase();
                if (result === "CH_SUCCEEDED" || status === "PAID") {
                    const chargeId = response.latestChargeId || intentId;
                    line.transaction_id = chargeId;
                    line.card_type = this.payment_method_id.name || "Beam Bolt+";
                    line.setReceiptInfo?.(_t("Beam: %s", chargeId));
                    line.setPaymentStatus("done");
                    delete line.uiState.beam_bolt_idempotency_key;
                    return this._finishPolling(true);
                }

                if (
                    ["BI_EXPIRED", "BI_CANCELED"].includes(result) ||
                    ["EXPIRED", "CANCELED", "VOIDED", "REFUNDED"].includes(status)
                ) {
                    const expired = result === "BI_EXPIRED" || status === "EXPIRED";
                    this._showError(
                        expired
                            ? _t("หมดเวลาชำระเงินบนเครื่อง Bolt+ กรุณารอ 5 วินาทีก่อนลองใหม่")
                            : _t("รายการบน Beam ถูกยกเลิกหรือปิดแล้ว")
                    );
                    line.transaction_id = "";
                    line.uiState.beam_retry_after = Date.now() + DEVICE_READY_DELAY_MS;
                    delete line.uiState.beam_bolt_intent_id;
                    delete line.uiState.beam_bolt_idempotency_key;
                    return this._finishPolling(false);
                }

                if (result && result.startsWith("CH_")) {
                    const messages = {
                        CH_PROCESSING_FAILED: _t("การประมวลผลชำระเงินล้มเหลว"),
                        CH_INSUFFICIENT_FUNDS: _t("ยอดเงินในบัตรหรือบัญชีไม่พอ"),
                        CH_AUTHENTICATION_FAILED: _t("ยืนยันตัวตนไม่สำเร็จ"),
                    };
                    this._showError(messages[result] || _t("ชำระเงินไม่สำเร็จ (%s)", result));
                    line.transaction_id = "";
                    line.uiState.beam_retry_after = Date.now() + DEVICE_READY_DELAY_MS;
                    delete line.uiState.beam_bolt_intent_id;
                    delete line.uiState.beam_bolt_idempotency_key;
                    return this._finishPolling(false);
                }

                this.pollingTimeout = setTimeout(poll, POLL_INTERVAL_MS);
            };
            poll();
        });
    }

    _finishPolling(value) {
        clearTimeout(this.pollingTimeout);
        this.pollingTimeout = null;
        const resolve = this.pollingResolve;
        this.pollingResolve = null;
        this.activeIntentId = null;
        this.activeLineUuid = null;
        if (resolve) {
            resolve(value);
        }
    }

    _showError(message) {
        this.env.services.dialog.add(AlertDialog, {
            title: _t("Beam Bolt+"),
            body: message,
        });
    }
}

register_payment_method("beam_bolt", PaymentBeamBolt);
