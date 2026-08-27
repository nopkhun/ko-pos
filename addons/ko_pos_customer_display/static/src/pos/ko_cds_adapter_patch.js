import { patch } from "@web/core/utils/patch";
import { CustomerDisplayPosAdapter } from "@point_of_sale/app/customer_display/customer_display_adapter";

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
    },
});
