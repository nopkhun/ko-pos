/** @odoo-module **/

import { onWillStart } from "@odoo/owl";
import { TicketScreen } from "@point_of_sale/app/screens/ticket_screen/ticket_screen";
import { formatCurrency } from "@web/core/currency";
import { patch } from "@web/core/utils/patch";
import { useService } from "@web/core/utils/hooks";
import { ask, makeAwaitable } from "@point_of_sale/app/utils/make_awaitable_dialog";
import { PartnerList } from "@point_of_sale/app/screens/partner_list/partner_list";
import { showKoToast } from "./ko_toast";
import { KoBottomNav } from "./ko_bottom_nav";

function timestamp(value) {
    if (!value) {
        return Date.now();
    }
    if (typeof value.toMillis === "function") {
        return value.toMillis();
    }
    return new Date(value).getTime();
}

function shortOrderNumber(order) {
    return String(order.pos_reference || order.name || order.tracking_number || "-").split("/").at(-1);
}

patch(TicketScreen, {
    components: {
        ...TicketScreen.components,
        KoBottomNav,
    },
});

patch(TicketScreen.prototype, {
    setup() {
        super.setup(...arguments);
        Object.assign(this.state, {
            koActiveTab: "open",
            koSelectedTicket: null,
            koConfirmVoid: false,
            koBusy: false,
        });
        this.koInvoiceService = useService("account_move");
        onWillStart(async () => {
            try {
                this.pos.screenState.ticketSCreen.totalCount = 0;
                this.pos.screenState.ticketSCreen.offsetByDomain = {};
                await this._fetchSyncedOrders();
                // Paid orders are only pulled from the server here, so their
                // kitchen state has to be re-read afterwards — otherwise a
                // takeaway that was paid on another device shows no dishes to
                // serve until the next bus notification.
                await this.pos.koRefreshKdsStatus?.();
            } catch (error) {
                console.error("KO POS billed orders load failed", error);
                showKoToast("โหลดบิลล่าสุดไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่อ");
            }
        });
    },

    get koTab() {
        return this.state.koActiveTab;
    },

    get koSelectedTicket() {
        return this.state.koSelectedTicket;
    },

    get koConfirmVoid() {
        return this.state.koConfirmVoid;
    },

    koSetTab(tab) {
        this.state.koActiveTab = tab;
        this.koCloseTicketSheet();
    },

    get koAllOrders() {
        return this.pos.models["pos.order"].getAll();
    },

    get koSessionSummary() {
        const paidOrders = this.koAllOrders.filter((order) => order.finalized);
        const total = paidOrders.reduce((sum, order) => sum + (order.priceIncl || 0), 0);
        const sessionName = this.pos.session?.name || this.pos.session?.display_name || "";
        const shortSession = String(sessionName).split("/").at(-1) || "-";
        return `รอบขาย #${shortSession} · ${paidOrders.length} บิล · ${formatCurrency(total, this.pos.currency.id)}`;
    },

    get koOpenOrders() {
        // Both ways an order can arrive belong in this tab. An unpaid table
        // order is obviously still open; a takeaway that was paid up front is
        // just as open until every dish has physically reached the customer.
        // Before ko_pos_ui 19.0.5.0.0 a paid order dropped straight into
        // "บิลแล้ว", where there is no per-dish serve button at all — so half
        // the orders in the restaurant could never be ticked off.
        return this.koAllOrders
            .filter((order) => {
                if (order.isEmpty() || order.isRefund) {
                    return false;
                }
                if (!order.finalized) {
                    return true;
                }
                return order
                    .getOrderlines()
                    .some(
                        (line) =>
                            line.koKitchenState &&
                            !["served", "cancelled"].includes(line.koKitchenState)
                    );
            })
            .map((order) => {
                const lines = order.getOrderlines();
                const isTakeaway = !order.table_id;
                const partnerName = order.getPartner?.()?.name || "";
                const elapsedMinutes = Math.max(
                    0,
                    Math.round((Date.now() - timestamp(order.server_create_date || order.date_order)) / 60000)
                );
                const typeLabel = isTakeaway ? "กลับบ้าน" : "ทานที่ร้าน";
                return {
                    order,
                    no: `#${shortOrderNumber(order)}`,
                    tableName: order.table_id
                        ? `โต๊ะ ${order.table_id.table_number}`
                        : partnerName || "สั่งกลับบ้าน",
                    isTakeaway,
                    isPaid: Boolean(order.finalized),
                    typeLabel: order.finalized ? `${typeLabel} · จ่ายแล้ว` : typeLabel,
                    elapsedMinutes,
                    isLate: elapsedMinutes >= (this.pos.config.ko_kds_sla_minutes || 15),
                    items: lines.map((line) => {
                        const kitchenState = line.koKitchenState || "not_sent";
                        const issue = line.koKitchenIssue || null;
                        const isServed = kitchenState === "served" || Boolean(line.koServed);
                        const isCancelled = kitchenState === "cancelled";
                        return {
                            line,
                            qty: line.getQuantity(),
                            name: line.getFullProductName(),
                            mods: line.getCustomerNote(),
                            // The station is a ko.kds.station name now, not one
                            // of three hard-coded codes.
                            station: "",
                            stationLabel: line.koKitchenStation || "",
                            isServed,
                            isCancelled,
                            isReady: kitchenState === "ready",
                            // The owner asked for a serve button that is always
                            // available, with a warning when the kitchen has not
                            // marked the dish ready yet.
                            canServe: !isServed && !isCancelled,
                            issueLabel: issue
                                ? `⚠ ${issue.label}${issue.note ? " · " + issue.note : ""}`
                                : "",
                            issueAck: Boolean(issue && issue.ack),
                            statusLabel:
                                kitchenState === "ready"
                                    ? "พร้อมเสิร์ฟ"
                                    : kitchenState === "cooking"
                                    ? "กำลังทำ"
                                    : kitchenState === "cancelled"
                                    ? "ยกเลิก"
                                    : "ยังไม่ส่งครัว",
                        };
                    }),
                };
            });
    },

    get koBilledOrders() {
        return this.koAllOrders
            .filter((order) => order.finalized)
            .sort((a, b) => timestamp(b.date_order) - timestamp(a.date_order))
            .map((order) => {
                const fullyRefunded = order.getOrderlines().every(
                    (line) => line.refundedQty >= Math.abs(line.qty)
                );
                const date = new Date(timestamp(order.date_order));
                return {
                    order,
                    no: `#${shortOrderNumber(order)}`,
                    tableName: order.table_id ? `โต๊ะ ${order.table_id.table_number}` : "สั่งกลับบ้าน",
                    timeStr: date.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }),
                    count: order.getOrderlines().length,
                    paymentName: order.payment_ids[0]?.payment_method_id?.name || "-",
                    totalFormatted: formatCurrency(order.priceIncl || 0, this.pos.currency.id),
                    isVoid: fullyRefunded || order.isRefund,
                    statusLabel: order.isRefund
                        ? "รายการคืนเงิน · Refund"
                        : fullyRefunded
                        ? "คืนเงินครบแล้ว · Refunded"
                        : "ชำระแล้ว · Paid",
                    hasTaxInvoice: Boolean(order.raw.account_move),
                };
            });
    },

    koOpenTicketSheet(ticket) {
        this.state.koSelectedTicket = ticket;
        this.state.koConfirmVoid = false;
    },

    koCloseTicketSheet() {
        this.state.koSelectedTicket = null;
        this.state.koConfirmVoid = false;
    },

    async koServeLine(order, line) {
        const kitchenState = line.koKitchenState || "not_sent";
        if (!["ready", "served"].includes(kitchenState)) {
            // Serving early is allowed — staff often carry a dish out before
            // the station taps "เสร็จ" — but it should never be a slip.
            const confirmed = await ask(this.dialog, {
                title: "ครัวยังไม่แจ้งว่าเสร็จ",
                body:
                    kitchenState === "not_sent"
                        ? `"${line.getFullProductName()}" ยังไม่ถูกส่งเข้าครัว ยืนยันว่าส่งมอบให้ลูกค้าแล้ว?`
                        : `"${line.getFullProductName()}" ครัวยังทำอยู่ ยืนยันว่าส่งมอบให้ลูกค้าแล้ว?`,
                confirmLabel: "ยืนยันว่าเสิร์ฟแล้ว",
                cancelLabel: "ยังไม่เสิร์ฟ",
            });
            if (!confirmed) {
                return;
            }
        }
        try {
            const served = await this.pos.data.call(
                "ko.kds.ticket",
                "serve_line_from_pos",
                [order.uuid, line.uuid]
            );
            if (!served) {
                showKoToast("ยังไม่พบรายการนี้บนจอครัว");
                return;
            }
            line.koServed = true;
            showKoToast("บันทึกว่าเสิร์ฟแล้ว");
        } catch (error) {
            console.error("KO KDS serve failed", error);
            showKoToast("บันทึกสถานะเสิร์ฟไม่สำเร็จ");
        }
    },

    async koReprintTicket() {
        const ticket = this.koSelectedTicket;
        if (!ticket || this.state.koBusy) {
            return;
        }
        this.state.koBusy = true;
        try {
            const result = await this.pos.printReceipt({ order: ticket.order });
            showKoToast(result ? `พิมพ์ใบเสร็จ ${ticket.no} แล้ว` : "พิมพ์ใบเสร็จไม่สำเร็จ");
        } finally {
            this.state.koBusy = false;
            this.koCloseTicketSheet();
        }
    },

    async koTaxInvoice() {
        const ticket = this.koSelectedTicket;
        if (!ticket || this.state.koBusy) {
            return;
        }
        if (!ticket.order.id || typeof ticket.order.id !== "number") {
            showKoToast("กรุณารอให้บิลบันทึกขึ้นระบบก่อน");
            return;
        }
        this.state.koBusy = true;
        try {
            let partner = ticket.order.getPartner();
            if (!partner) {
                partner = await makeAwaitable(this.dialog, PartnerList);
                if (!partner) {
                    return;
                }
                await this.pos.data.ormWrite("pos.order", [ticket.order.id], {
                    partner_id: partner.id,
                });
            }
            if (!ticket.order.raw.account_move) {
                await this.pos.data.call("pos.order", "action_pos_order_invoice", [ticket.order.id]);
            }
            const [refreshed] = await this.pos.data.loadServerOrders([
                ["id", "=", ticket.order.id],
            ]);
            const accountMoveId = refreshed?.raw.account_move;
            if (accountMoveId) {
                await this.koInvoiceService.downloadPdf(accountMoveId);
            }
            showKoToast(`ออกใบกำกับภาษีเต็มรูป ${ticket.no} แล้ว`);
            this.koCloseTicketSheet();
        } catch (error) {
            console.error("KO POS invoice failed", error);
            showKoToast("ออกใบกำกับภาษีไม่สำเร็จ กรุณาตรวจสอบข้อมูลลูกค้า");
        } finally {
            this.state.koBusy = false;
        }
    },

    _koReplacementLines(order) {
        return order
            .getOrderlines()
            .filter((line) => !line.combo_parent_id)
            .map((line) => ({
                productTemplate: line.product_id.product_tmpl_id,
                qty: Math.abs(line.qty),
                customerNote: line.getCustomerNote(),
                payload: {
                    attribute_value_ids: line.attribute_value_ids.map((value) => value.id),
                    attribute_custom_values: Object.fromEntries(
                        (line.custom_attribute_value_ids || []).map((item) => [
                            item.custom_product_template_attribute_value_id.id,
                            item.custom_value,
                        ])
                    ),
                    price_extra: line.price_extra || 0,
                    qty: Math.abs(line.qty),
                },
            }));
    },

    async _koStartFullRefund(type) {
        const ticket = this.koSelectedTicket;
        if (!ticket || this.state.koBusy) {
            return;
        }
        const order = ticket.order;
        this.setSelectedOrder(order);
        const firstLine = order.getOrderlines()[0];
        if (firstLine) {
            this.state.selectedOrderlineIds[order.id] = firstLine.id;
        }
        let refundable = 0;
        for (const line of order.getOrderlines()) {
            const qty = Math.max(0, Math.abs(line.qty) - line.refundedQty);
            const detail = this.getToRefundDetail(line);
            detail.qty = qty;
            refundable += qty;
        }
        if (!refundable) {
            showKoToast("บิลนี้คืนเงินครบแล้ว");
            return;
        }

        this.pos.koRefundIntent = {
            type,
            sourceOrderUuid: order.uuid,
            lines: type === "edit" ? this._koReplacementLines(order) : [],
            refundOrderUuid: null,
        };
        this.state.koBusy = true;
        try {
            await this.onDoRefund();
            const refundOrder = this.pos.getOrder();
            if (refundOrder?.isRefund) {
                this.pos.koRefundIntent.refundOrderUuid = refundOrder.uuid;
                try {
                    sessionStorage.setItem(
                        `ko_pos_refund_intent_${refundOrder.uuid}`,
                        JSON.stringify({
                            ...this.pos.koRefundIntent,
                            lines: this.pos.koRefundIntent.lines.map((item) => ({
                                productTemplateId: item.productTemplate.id,
                                qty: item.qty,
                                customerNote: item.customerNote,
                                payload: item.payload,
                            })),
                        })
                    );
                } catch (error) {
                    console.warn("KO POS could not persist refund edit intent", error);
                }
                this.koCloseTicketSheet();
                showKoToast(
                    type === "edit"
                        ? "กรุณาคืนเงินบิลเดิม แล้วระบบจะโหลดรายการให้แก้ไข"
                        : "สร้างรายการคืนเงินแล้ว กรุณาตรวจสอบและยืนยัน"
                );
            } else {
                this.pos.koRefundIntent = null;
            }
        } finally {
            this.state.koBusy = false;
        }
    },

    koEditBill() {
        return this._koStartFullRefund("edit");
    },

    koVoidBill() {
        if (!this.koSelectedTicket) {
            return;
        }
        if (!this.state.koConfirmVoid) {
            this.state.koConfirmVoid = true;
            return;
        }
        return this._koStartFullRefund("void");
    },
});
