import { _t } from "@web/core/l10n/translation";
import { PaymentInterface } from "@point_of_sale/app/utils/payment/payment_interface";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { register_payment_method } from "@point_of_sale/app/services/pos_store";

const POLL_INTERVAL_MS = 2500;
const MAX_POLL_INTERVAL_MS = 15000;
// Beam ไม่มี API ยกเลิก charge — QR ตายด้วย expiryTime เท่านั้น หลังหมดอายุ
// เผื่อเวลาให้ระบบ Beam ปิดสถานะเองก่อนเราสรุปว่า "หมดเวลา"
const EXPIRY_GRACE_MS = 20000;

function makeIdempotencyKey() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }
    return `ko-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function paymentLine(order, uuid) {
    return order?.payment_ids?.find((line) => line.uuid === uuid) || order?.getSelectedPaymentline();
}

function isChargeId(value) {
    return typeof value === "string" && value.startsWith("ch_");
}

function idempotencyFromLine(line) {
    const value = line?.transaction_id || "";
    return value.startsWith("beam-qr-idem:") ? value.slice("beam-qr-idem:".length) : null;
}

function chargeStatus(response) {
    return String(response?.status || "").toUpperCase();
}

/**
 * Beam QR บนจอลูกค้า — สร้าง charge ผ่าน Charges API, ส่งภาพ QR ขึ้นจอลูกค้า
 * แล้ว poll สถานะจน SUCCEEDED / FAILED / หมดอายุ
 *
 * แนวเดียวกับ PaymentBeamBolt: เก็บ idempotency key ไว้ใน transaction_id
 * ระหว่างที่ยังไม่รู้ Charge ID เพื่อให้ Retry ยิงซ้ำแบบปลอดภัย ไม่สร้างรายการซ้ำ
 */
export class PaymentBeamQr extends PaymentInterface {
    setup() {
        super.setup(...arguments);
        this.pollingTimeout = null;
        this.pollingResolve = null;
        this.cancelled = false;
        this.activeChargeId = null;
    }

    async sendPaymentRequest(uuid) {
        await super.sendPaymentRequest(...arguments);
        const order = this.pos.getOrder();
        const line = paymentLine(order, uuid);
        this.cancelled = false;

        if (!line) {
            this._showError(_t("ไม่พบรายการชำระเงิน Beam QR"));
            return false;
        }
        if (line.amount <= 0) {
            // Charges API คืนเงินจาก POS ไม่ได้ — เข้าเส้นทางคืนเงินภายนอก
            // (Lighthouse / อ้างอิงรายการโอน) ของหน้าจ่ายเงิน KO ตามปกติ
            line.uiState = line.uiState || {};
            line.uiState.beam_refund_external_required = true;
            this._showError(
                _t("QR คืนเงินผ่าน POS ไม่ได้ กรุณาคืนผ่าน Lighthouse หรือช่องทางโอน แล้วบันทึกเลขอ้างอิง")
            );
            return false;
        }

        line.uiState = line.uiState || {};
        const existingChargeId = isChargeId(line.transaction_id)
            ? line.transaction_id
            : line.uiState.beam_qr_charge_id;
        if (existingChargeId) {
            // มีรายการค้างอยู่ (เช่นหลังรีเฟรชหน้า) — ตามสถานะเดิม ไม่สร้างใหม่
            line.setPaymentStatus("waitingCard");
            return await this._pollUntilResolved(line, existingChargeId, null);
        }

        const idempotencyKey =
            line.uiState.beam_qr_idempotency_key || idempotencyFromLine(line) || makeIdempotencyKey();
        line.uiState.beam_qr_idempotency_key = idempotencyKey;
        line.transaction_id = `beam-qr-idem:${idempotencyKey}`;
        line.setPaymentStatus("waitingCard");

        const referenceId = `KO-${order.uuid || "order"}-${line.uuid || "payment"}`
            .replace(/[^A-Za-z0-9_-]/g, "")
            .slice(0, 100);
        const response = await this._callBeam("beam_qr_create_charge", {
            amount_thb: line.amount,
            reference_id: referenceId,
            idempotency_key: idempotencyKey,
        });
        if (!response || response.error) {
            this._showError(response?.error || _t("สร้าง QR ชำระเงินไม่สำเร็จ"));
            if (response?.charge_id) {
                // charge เกิดขึ้นแล้วแต่ไม่ได้ภาพ QR — เก็บ id ไว้ให้ Retry ตามสถานะเดิม
                line.uiState.beam_qr_charge_id = response.charge_id;
                line.transaction_id = response.charge_id;
            } else if (!response?.retryable) {
                line.transaction_id = "";
                delete line.uiState.beam_qr_idempotency_key;
            }
            return false;
        }

        const chargeId = response.charge_id;
        line.uiState.beam_qr_charge_id = chargeId;
        line.transaction_id = chargeId;

        const expiryMs = response.qr_expiry ? Date.parse(response.qr_expiry) : NaN;
        this._setQrOnDisplays(line, {
            qrCode: "data:image/png;base64," + response.qr_image_base64,
            name: this.payment_method_id.name || "Beam QR",
            amount: this.env.utils.formatCurrency(line.amount),
            expiry: response.qr_expiry || "",
        });

        return await this._pollUntilResolved(line, chargeId, Number.isNaN(expiryMs) ? null : expiryMs);
    }

    async sendPaymentCancel(order, uuid) {
        await super.sendPaymentCancel(...arguments);
        const line = paymentLine(order, uuid) || this.pos.getPendingPaymentLine("beam_qr");
        if (!line) {
            return true;
        }
        line.uiState = line.uiState || {};
        let chargeId = line.uiState.beam_qr_charge_id;
        if (!chargeId && isChargeId(line.transaction_id)) {
            chargeId = line.transaction_id;
        }

        // create ที่ timeout ไปอาจสำเร็จที่ Beam โดยเราไม่รู้ Charge ID —
        // ยิงซ้ำด้วย idempotency key เดิมเพื่อเอา id จริงกลับมาก่อนตัดสินใจ
        const uncertainKey = idempotencyFromLine(line);
        if (!chargeId && uncertainKey) {
            const recovered = await this._callBeam("beam_qr_create_charge", {
                amount_thb: line.amount,
                reference_id: `KO-${order?.uuid || "order"}-${line.uuid || "payment"}`
                    .replace(/[^A-Za-z0-9_-]/g, "")
                    .slice(0, 100),
                idempotency_key: uncertainKey,
            });
            chargeId = recovered?.charge_id || null;
            if (!chargeId && recovered?.error && recovered?.retryable) {
                this._showError(
                    _t("ยังยืนยันไม่ได้ว่ารายการถูกสร้างหรือไม่ กรุณาตรวจสอบอินเทอร์เน็ตแล้วกดยกเลิกอีกครั้ง")
                );
                return false;
            }
        }

        if (chargeId) {
            // ไม่มี API ยกเลิก charge — เช็คก่อนปล่อยว่าลูกค้าจ่ายไปแล้วหรือยัง
            const current = await this._callBeam("beam_qr_get_charge", { charge_id: chargeId });
            if (chargeStatus(current) === "SUCCEEDED") {
                this._showError(
                    _t("Beam ยืนยันว่าลูกค้าชำระรายการนี้สำเร็จแล้ว ระบบกำลังบันทึกผล กรุณาอย่าเลือกช่องทางใหม่")
                );
                this._finishPolling(false);
                return false;
            }
            this._showError(
                _t(
                    "ยกเลิกฝั่ง POS แล้ว แต่ QR เดิมยังสแกนได้จนหมดอายุ หากลูกค้าเผลอสแกนจ่ายภายหลัง ให้ตรวจสอบใน Beam Lighthouse"
                )
            );
        }

        this.cancelled = true;
        this._finishPolling(false);
        this._setQrOnDisplays(line, null);
        line.transaction_id = "";
        delete line.uiState.beam_qr_charge_id;
        delete line.uiState.beam_qr_idempotency_key;
        return true;
    }

    close() {
        this.cancelled = true;
        this._finishPolling(false);
    }

    _setQrOnDisplays(line, qrPaymentData) {
        line.qrPaymentData = qrPaymentData;
        if (this.pos.customerDisplay) {
            this.pos.customerDisplay.update();
        }
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

    _pollUntilResolved(line, chargeId, expiryMs) {
        this._finishPolling(false);
        this.cancelled = false;
        this.activeChargeId = chargeId;

        return new Promise((resolve) => {
            this.pollingResolve = resolve;
            let consecutiveErrors = 0;
            let errorShown = false;

            const finishFailure = (message) => {
                this._showError(message);
                this._setQrOnDisplays(line, null);
                line.transaction_id = "";
                delete line.uiState.beam_qr_charge_id;
                delete line.uiState.beam_qr_idempotency_key;
                return this._finishPolling(false);
            };

            const poll = async () => {
                clearTimeout(this.pollingTimeout);
                if (this.cancelled || line.getPaymentStatus?.() === "retry") {
                    return this._finishPolling(false);
                }
                const response = await this._callBeam("beam_qr_get_charge", {
                    charge_id: chargeId,
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
                const status = chargeStatus(response);
                if (status === "SUCCEEDED") {
                    line.transaction_id = chargeId;
                    line.card_type = this.payment_method_id.name || "Beam QR";
                    line.setReceiptInfo?.(_t("Beam: %s", chargeId));
                    line.setPaymentStatus("done");
                    this._setQrOnDisplays(line, null);
                    delete line.uiState.beam_qr_idempotency_key;
                    return this._finishPolling(true);
                }
                if (status === "FAILED") {
                    return finishFailure(_t("การชำระเงินไม่สำเร็จ กรุณาลองใหม่หรือเลือกช่องทางอื่น"));
                }
                if (["EXPIRED", "CANCELED", "VOIDED"].includes(status)) {
                    return finishFailure(_t("QR หมดอายุหรือถูกปิดแล้ว กรุณาสร้างรายการใหม่"));
                }
                if (expiryMs && Date.now() > expiryMs + EXPIRY_GRACE_MS) {
                    return finishFailure(_t("QR หมดอายุแล้ว กรุณาสร้างรายการใหม่"));
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
        this.activeChargeId = null;
        if (resolve) {
            resolve(value);
        }
    }

    _showError(message) {
        this.env.services.dialog.add(AlertDialog, {
            title: _t("Beam QR"),
            body: message,
        });
    }
}

register_payment_method("beam_qr", PaymentBeamQr);
