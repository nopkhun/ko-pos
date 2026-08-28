import { patch } from "@web/core/utils/patch";
import { effect } from "@web/core/utils/reactive";
import { batched } from "@web/core/utils/timing";
import { Chrome } from "@point_of_sale/app/pos_app";
import { CustomerDisplayPosAdapter } from "@point_of_sale/app/customer_display/customer_display_adapter";

// หน้าที่ "ลูกค้าควรเห็นออเดอร์ของตัวเอง" — หน้าอื่น (โต๊ะ, รายการบิล, login, พักจอ)
// ถือว่าจอลูกค้าว่าง เป็น allowlist โดยตั้งใจ: หน้าใหม่ที่ยังไม่รู้จักให้ว่างไว้ก่อน
// ดีกว่าปล่อยให้ค้างรายการเดิม
const KO_ORDER_PAGES = new Set([
    "ProductScreen",
    "PaymentScreen",
    "ReceiptScreen",
    "FeedbackScreen",
    "SplitBillScreen",
    "TipScreen",
]);

// เพิ่มข้อมูลที่จอลูกค้าฝั่ง KO ใช้ นอกเหนือจากที่ Odoo ส่งอยู่แล้ว:
// โต๊ะ/โซน คิว และชื่อลูกค้า — เป็นข้อมูลอ่านอย่างเดียว ไม่แตะ logic การขาย
patch(CustomerDisplayPosAdapter.prototype, {
    formatOrderData(order) {
        super.formatOrderData(order);
        const table = order.table_id;
        const tableNumber = table ? table.table_number ?? table.name : null;
        this.data.koTable = tableNumber != null && tableNumber !== "" ? String(tableNumber) : "";
        this.data.koFloor = table?.floor_id?.name || "";
        this.data.koTracking = order.tracking_number ? String(order.tracking_number) : "";
        this.data.koCustomer = order.partner_id?.name || "";
        this.data.koIdle = false;
    },

    /**
     * สถานะ "จอว่าง" — ฝั่งจอลูกค้าเอาข้อมูลใหม่ไป Object.assign ทับของเดิม
     * (ไม่ได้แทนทั้งก้อน) ส่งแค่ธง koIdle จึงปลอดภัยกว่าไล่ล้างทุกฟิลด์:
     * template ฝั่งจอซ่อนรายการเองเมื่อ koIdle ส่วน qrPaymentData ต้องล้างจริง
     * ไม่งั้น dialog QR ค้างเปิดอยู่บนจอ
     */
    koFormatIdleData() {
        this.data = { koIdle: true, qrPaymentData: false };
    },
});

patch(Chrome.prototype, {
    setup() {
        super.setup();
        // Odoo ส่งข้อมูลไปจอลูกค้าเฉพาะตอน "ออเดอร์ที่เลือก" เปลี่ยนเท่านั้น และ
        // pos.navigate() ไม่เคยล้าง selectedOrderUuid ตอนกลับไปหน้าโต๊ะ/รายการบิล
        // จอลูกค้าจึงค้างรายการเดิมค้างอยู่ทั้งที่พนักงานออกจากหน้าออเดอร์ไปแล้ว
        // เลยเฝ้าหน้าปัจจุบันเพิ่มอีกทาง แล้วส่งสถานะว่างเมื่อออกจากหน้าออเดอร์
        this._koDisplayIdle = false;
        effect(
            batched((router) => {
                this.koSyncCustomerDisplay(router.state.current);
            }),
            [this.pos.router]
        );
    },

    sendOrderToCustomerDisplay(selectedOrder, scaleData) {
        if (!selectedOrder || !KO_ORDER_PAGES.has(this.pos.router.state.current)) {
            this.koSendIdleToCustomerDisplay();
            return;
        }
        this._koDisplayIdle = false;
        super.sendOrderToCustomerDisplay(selectedOrder, scaleData);
    },

    koSyncCustomerDisplay(page) {
        if (!KO_ORDER_PAGES.has(page)) {
            this.koSendIdleToCustomerDisplay();
            return;
        }
        const order = this.pos.getOrder();
        if (order) {
            this.sendOrderToCustomerDisplay(order, null);
        } else {
            this.koSendIdleToCustomerDisplay();
        }
    },

    koSendIdleToCustomerDisplay() {
        // พนักงานเดินไป-มาระหว่างหน้าโต๊ะกับรายการบิลบ่อยมาก ส่งซ้ำทุกครั้งไม่มีประโยชน์
        // และเปลือง RPC — ส่งครั้งเดียวจนกว่าจะกลับไปแสดงออเดอร์จริงอีกรอบ
        if (this._koDisplayIdle) {
            return;
        }
        this._koDisplayIdle = true;
        const adapter = new CustomerDisplayPosAdapter();
        adapter.koFormatIdleData();
        adapter.dispatch(this.pos);
    },
});
