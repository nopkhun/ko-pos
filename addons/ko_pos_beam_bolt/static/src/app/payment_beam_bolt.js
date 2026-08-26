import { _t } from "@web/core/l10n/translation";
import { PaymentInterface } from "@point_of_sale/app/utils/payment/payment_interface";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { register_payment_method } from "@point_of_sale/app/services/pos_store";

const POLL_INTERVAL_MS = 2500;
const MAX_POLL_INTERVAL_MS = 15000;
const DEVICE_READY_DELAY_MS = 5000;
const MAX_REFUND_POLLS = 60;

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

function refundIdempotencyFromLine(line) {
    const value = line?.transaction_id || "";
    return value.startsWith("beam-refund-idem:")
        ? value.slice("beam-refund-idem:".length)
        : null;
}

function isRefundId(value) {
    return typeof value === "string" && value.startsWith("re_");
}

function beamOutcome(response) {
    return {
        result: (response?.result || "").toUpperCase(),
        status: (response?.status || "").toUpperCase(),
    };
}

function isBeamSuccess(response) {
    const { result, status } = beamOutcome(response);
    return result === "CH_SUCCEEDED" || status === "PAID";
}

function isBeamCanceled(response) {
    const { result, status } = beamOutcome(response);
    return (
        ["BI_EXPIRED", "BI_CANCELED"].includes(result) ||
        ["EXPIRED", "CANCELED", "VOIDED", "REFUNDED"].includes(status)
    );
}

function isBeamFailed(response) {
    const { result } = beamOutcome(response);
    return Boolean(result && result.startsWith("CH_") && result !== "CH_SUCCEEDED");
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
            return await this._sendPosVoid(order, line);
        }

        line.uiState = line.uiState || {};
        const existingIntentId = isBoltIntentId(line.transaction_id)
            ? line.transaction_id
            : line.uiState.beam_bolt_intent_id;
        if (existingIntentId) {
            line.setPaymentStatus("waitingCard");
            return await this._pollUntilResolved(line, existingIntentId);
        }

        // Beam requires one physical device to rest for five seconds after any
        // cancel/expiry. Keep the deadline on the POS as well as the line so it
        // is shared by Card, PromptPay and every other method using that device.
        const retryAfter = Math.max(
            line.uiState.beam_retry_after || 0,
            this.pos.beamBoltReadyAfter || 0
        );
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

    _refundSourcePayments(order) {
        const sourceOrders = new Map();
        for (const line of order?.getOrderlines?.() || []) {
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
    }

    async _sendPosVoid(order, line) {
        const sourcePayments = this._refundSourcePayments(order);
        if (sourcePayments.length !== 1) {
            this._showError(
                _t("บิลนี้ชำระหลายช่องทางหรือไม่พบรายการต้นฉบับ กรุณาให้ผู้จัดการดำเนินการใน Beam Lighthouse")
            );
            line.uiState = line.uiState || {};
            line.uiState.beam_refund_external_required = true;
            return false;
        }
        const source = sourcePayments[0];
        if (source.payment_method_id?.id !== this.payment_method_id.id) {
            this._showError(_t("กรุณาเลือกช่องทางเดียวกับบัตรที่ใช้ชำระบิลต้นฉบับ"));
            return false;
        }

        line.uiState = line.uiState || {};
        delete line.uiState.beam_refund_failed;
        let refundId = isRefundId(line.transaction_id) ? line.transaction_id : null;
        if (!refundId) {
            const recoveryKey = refundIdempotencyFromLine(line);
            const idempotencyKey =
                line.uiState.beam_refund_idempotency_key ||
                recoveryKey ||
                makeIdempotencyKey();
            line.uiState.beam_refund_idempotency_key = idempotencyKey;
            line.transaction_id = `beam-refund-idem:${idempotencyKey}`;
            const created = await this._callBeam("beam_create_pos_void", {
                original_payment_id: source.id,
                charge_id: source.transaction_id,
                amount_thb: Math.abs(line.amount),
                reason: `KO POS void ${order.pos_reference || order.name || order.uuid || ""}`.trim(),
                idempotency_key: idempotencyKey,
                recovery: Boolean(recoveryKey),
            });
            if (!created || created.error) {
                if (created?.external_required) {
                    line.uiState.beam_refund_external_required = true;
                    line.transaction_id = "";
                    delete line.uiState.beam_refund_idempotency_key;
                }
                this._showError(created?.error || _t("ส่งคำขอ Void ไป Beam ไม่สำเร็จ"));
                return false;
            }
            refundId = created.refundId || created.id;
            if (!refundId) {
                this._showError(
                    _t("Beam ไม่ส่ง Refund ID กลับมา กรุณาอย่าส่งซ้ำและตรวจสอบ Lighthouse")
                );
                return false;
            }
            line.transaction_id = refundId;
        }

        const result = await this._pollRefund(line, refundId);
        if (!result) {
            return false;
        }
        const transactionType = String(result.transactionType || "REVERSAL").toUpperCase();
        line.card_type = `${this.payment_method_id.name || "Beam"} ${transactionType}`;
        line.payment_ref_no = refundId;
        line.setReceiptInfo?.(_t("Beam %s: %s", transactionType, refundId));
        line.uiState.beam_refund_result = transactionType;
        delete line.uiState.beam_refund_idempotency_key;
        return true;
    }

    async _pollRefund(line, refundId) {
        let consecutiveErrors = 0;
        for (let attempt = 0; attempt < MAX_REFUND_POLLS; attempt += 1) {
            const response = await this._callBeam("beam_get_refund", { refund_id: refundId });
            if (response?.error) {
                consecutiveErrors += 1;
                if (!response.retryable || consecutiveErrors >= 3) {
                    this._showError(
                        _t("ยังตรวจสอบผล Void จาก Beam ไม่ได้ กรุณาอย่าส่งรายการซ้ำและตรวจสอบ Lighthouse")
                    );
                    return false;
                }
            } else {
                consecutiveErrors = 0;
                const status = String(response?.status || "").toUpperCase();
                if (status === "SUCCEEDED") {
                    return response;
                }
                if (status === "FAILED") {
                    line.uiState.beam_refund_failed = true;
                    line.payment_ref_no = refundId;
                    line.transaction_id = "";
                    delete line.uiState.beam_refund_idempotency_key;
                    this._showError(_t("Beam ปฏิเสธการ Void กรุณาตรวจสอบใน Lighthouse"));
                    return false;
                }
            }
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
        this._showError(
            _t("Beam ยังประมวลผล Void อยู่ กรุณาเก็บหน้าจอนี้ไว้และกดยืนยันอีกครั้งเพื่อตรวจสอบสถานะเดิม")
        );
        return false;
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
            const cancelResult = await this._callBeam("beam_cancel_bolt_intent", {
                bolt_intent_id: intentId,
                idempotency_key: makeIdempotencyKey(),
            });
            if (cancelResult?.error && cancelResult.status_code !== 404) {
                // The customer may already have cancelled on the Bolt app. In
                // that case Beam can reject a second cancel even though the
                // intent is final. Reconcile before deciding whether Odoo may
                // release its global payment-terminal lock.
                const current = await this._callBeam("beam_get_bolt_intent", {
                    bolt_intent_id: intentId,
                });
                if (!current?.error && (isBeamCanceled(current) || isBeamFailed(current))) {
                    // Beam reports a final outcome, so Odoo may release the
                    // terminal lock. Operations still reconcile late charges
                    // according to Beam's documented cancellation caveat.
                } else {
                    this._showError(
                        isBeamSuccess(current)
                            ? _t("Beam ยืนยันว่ารายการนี้ชำระสำเร็จแล้ว ระบบกำลังบันทึกผล กรุณาอย่าเลือกช่องทางใหม่")
                            : _t("ยกเลิกรายการบน Beam ไม่สำเร็จ ระบบจะตรวจสอบสถานะต่อ กรุณาอย่ารับชำระซ้ำ")
                    );
                    return false;
                }
            }
        }

        this.cancelled = true;
        this._finishPolling(false);
        line.transaction_id = "";
        delete line.uiState.beam_bolt_intent_id;
        delete line.uiState.beam_bolt_idempotency_key;
        this._markDeviceCoolingDown(line);
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

    _markDeviceCoolingDown(line) {
        const readyAfter = Date.now() + DEVICE_READY_DELAY_MS;
        this.pos.beamBoltReadyAfter = readyAfter;
        if (line) {
            line.uiState = line.uiState || {};
            line.uiState.beam_retry_after = readyAfter;
        }
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
                if (this.cancelled || line.getPaymentStatus?.() === "retry") {
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
                const { result, status } = beamOutcome(response);
                if (isBeamSuccess(response)) {
                    const chargeId = response.latestChargeId || intentId;
                    line.transaction_id = chargeId;
                    line.card_type = this.payment_method_id.name || "Beam Bolt+";
                    line.setReceiptInfo?.(_t("Beam: %s", chargeId));
                    line.setPaymentStatus("done");
                    delete line.uiState.beam_bolt_idempotency_key;
                    return this._finishPolling(true);
                }

                if (isBeamCanceled(response)) {
                    const expired = result === "BI_EXPIRED" || status === "EXPIRED";
                    this._showError(
                        expired
                            ? _t("หมดเวลาชำระเงินบนเครื่อง Bolt+ กรุณารอ 5 วินาทีก่อนลองใหม่")
                            : _t("รายการบน Beam ถูกยกเลิกหรือปิดแล้ว")
                    );
                    line.transaction_id = "";
                    this._markDeviceCoolingDown(line);
                    delete line.uiState.beam_bolt_intent_id;
                    delete line.uiState.beam_bolt_idempotency_key;
                    return this._finishPolling(false);
                }

                if (isBeamFailed(response)) {
                    const messages = {
                        CH_PROCESSING_FAILED: _t("การประมวลผลชำระเงินล้มเหลว"),
                        CH_INSUFFICIENT_FUNDS: _t("ยอดเงินในบัตรหรือบัญชีไม่พอ"),
                        CH_AUTHENTICATION_FAILED: _t("ยืนยันตัวตนไม่สำเร็จ"),
                    };
                    this._showError(messages[result] || _t("ชำระเงินไม่สำเร็จ (%s)", result));
                    line.transaction_id = "";
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
