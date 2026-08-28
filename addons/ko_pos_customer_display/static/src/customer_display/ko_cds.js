import { patch } from "@web/core/utils/patch";
import { CustomerDisplay } from "@point_of_sale/customer_display/customer_display";
import { CustomerFacingQR } from "@point_of_sale/customer_display/customer_facing_qr";
import { session } from "@web/session";
import { useState, useEffect, onWillUnmount } from "@odoo/owl";
import { KoCdsAds } from "./ko_cds_ads";

// ใช้ layout ของ KO ทั้งหน้า (ไทย + ปรับตามอุปกรณ์) แทน template เดิมของ Odoo
CustomerDisplay.template = "ko_pos_customer_display.CustomerDisplay";
CustomerDisplay.components = { ...CustomerDisplay.components, KoCdsAds };
CustomerFacingQR.template = "ko_pos_customer_display.CustomerFacingQR";
// เผื่อ payment flow (เช่น Beam QR) ส่งเวลาหมดอายุมาด้วย — เป็น prop เสริม ไม่บังคับ
CustomerFacingQR.props = { ...CustomerFacingQR.props, expiry: { type: String, optional: true } };

patch(CustomerDisplay.prototype, {
    setup() {
        super.setup();
        this.koCds = session.ko_cds || {
            shop_name: "",
            idle_seconds: 15,
            image_seconds: 8,
            playlist: [],
        };
        this.koState = useState({ showAds: false });
        this._koLastActive = Date.now();
        const tick = setInterval(() => this._koCheckIdle(), 1000);
        onWillUnmount(() => clearInterval(tick));
        // มีความเคลื่อนไหวของออเดอร์เมื่อไหร่ ตัดโฆษณาออกทันที ไม่รอ tick วินาทีถัดไป
        useEffect(
            () => this._koCheckIdle(),
            () => [
                this.order.lines?.length,
                this.order.finalized,
                this.order.qrPaymentData,
                this.order.koIdle,
            ]
        );
    },

    _koOrderIsActive() {
        const order = this.order;
        // พนักงานออกจากหน้าออเดอร์ไปแล้ว (หน้าโต๊ะ / รายการบิล) — ฝั่ง POS ส่งธงนี้มา
        // รายการเดิมยังค้างอยู่ใน data เพราะจอ merge ข้อมูลใหม่ทับ ไม่ได้แทนทั้งก้อน
        if (order?.koIdle) {
            return false;
        }
        if (order?.qrPaymentData) {
            return true;
        }
        return !!(order?.lines?.length && !order.finalized);
    },

    _koCheckIdle() {
        if (this._koOrderIsActive()) {
            this._koLastActive = Date.now();
            if (this.koState.showAds) {
                this.koState.showAds = false;
            }
            return;
        }
        const shouldShow =
            this.koCds.playlist.length > 0 &&
            Date.now() - this._koLastActive >= this.koCds.idle_seconds * 1000;
        if (shouldShow !== this.koState.showAds) {
            this.koState.showAds = shouldShow;
        }
    },
});

patch(CustomerFacingQR.prototype, {
    setup() {
        super.setup();
        this.title = `สแกน QR เพื่อชำระด้วย ${this.props.name}`;
        this.koQr = useState({ remaining: "" });
        const expiryMs = this.props.expiry ? Date.parse(this.props.expiry) : NaN;
        if (!Number.isNaN(expiryMs)) {
            const update = () => {
                const left = Math.max(0, Math.round((expiryMs - Date.now()) / 1000));
                const minutes = Math.floor(left / 60);
                const seconds = String(left % 60).padStart(2, "0");
                this.koQr.remaining = left > 0 ? `${minutes}:${seconds}` : "";
            };
            update();
            const timer = setInterval(update, 1000);
            onWillUnmount(() => clearInterval(timer));
        }
    },
});
