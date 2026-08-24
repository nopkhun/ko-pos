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

/** Kitchen states that mean the dish has already cost the kitchen work. */
const KITCHEN_BUSY_STATES = ["cooking", "ready", "served"];

const KITCHEN_BUSY_LABEL = {
    cooking: "ครัวกำลังทำอยู่",
    ready: "ครัวทำเสร็จรออยู่",
    served: "เสิร์ฟให้ลูกค้าไปแล้ว",
};

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

/**
 * How much of this line has actually been paid back.
 *
 * Odoo's own `line.refundedQty` counts every refund line that merely *exists*,
 * including one sitting in a draft refund order nobody has paid yet. Using it
 * to decide "is this bill refunded?" marks a bill as fully refunded the second
 * someone opens the refund screen — even if they walk away and no money ever
 * leaves the drawer. Only a finalized refund settles anything.
 */
function settledRefundedQty(line) {
    return (line.refund_orderline_ids || []).reduce(
        (total, refundLine) =>
            refundLine.order_id?.finalized && refundLine.order_id?.state !== "cancel"
                ? total - refundLine.qty
                : total,
        0
    );
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
            // Hold the uuid, not a snapshot object: the sheet has to re-read the
            // order after every refund step, otherwise the quantities on screen
            // are the ones from the moment it was opened.
            koSelectedTicketUuid: null,
            koConfirmVoid: false,
            koBusy: false,
            koRefundQty: {},
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

    get koConfirmVoid() {
        return this.state.koConfirmVoid;
    },

    get koBusy() {
        return this.state.koBusy;
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
        // Everything still owed something belongs in this tab:
        //  - an unpaid order, obviously;
        //  - a takeaway paid up front, until every dish has physically reached
        //    the customer (before 19.0.5.0.0 those dropped into "บิลแล้ว",
        //    where there is no per-dish serve button at all);
        //  - a refund that was started and never finished. Those used to match
        //    neither tab, so an abandoned refund was invisible *and*
        //    undeletable, and it blocked closing the session.
        return this.koAllOrders
            .filter((order) => {
                if (order.isRefund) {
                    return !order.finalized && !order.isEmpty();
                }
                if (order.isEmpty()) {
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
                const isRefund = Boolean(order.isRefund);
                const partnerName = order.getPartner?.()?.name || "";
                const elapsedMinutes = Math.max(
                    0,
                    Math.round((Date.now() - timestamp(order.server_create_date || order.date_order)) / 60000)
                );
                const typeLabel = isTakeaway ? "กลับบ้าน" : "ทานที่ร้าน";
                return {
                    order,
                    no: `#${shortOrderNumber(order)}`,
                    tableName: isRefund
                        ? "รายการคืนเงิน"
                        : order.table_id
                        ? `โต๊ะ ${order.table_id.table_number}`
                        : partnerName || "สั่งกลับบ้าน",
                    isTakeaway,
                    isRefund,
                    isPaid: Boolean(order.finalized),
                    // An unpaid, non-refund order is the only thing anyone can
                    // key more food into.
                    canEdit: !order.finalized && !isRefund,
                    typeLabel: isRefund
                        ? "คืนเงิน · ยังไม่จบ"
                        : order.finalized
                        ? `${typeLabel} · จ่ายแล้ว`
                        : typeLabel,
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
                            canServe: !isRefund && !isServed && !isCancelled,
                            canEditQty: !order.finalized && !isRefund,
                            kitchenBusy: KITCHEN_BUSY_STATES.includes(kitchenState),
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
                const orderLines = order.getOrderlines();
                const unitPrice = (line) => {
                    const qty = Math.abs(line.qty) || 1;
                    return (line.price_subtotal_incl || 0) / qty;
                };
                const lines = orderLines.map((line) => {
                    const qty = Math.abs(line.qty);
                    const refunded = settledRefundedQty(line);
                    return {
                        line,
                        uuid: line.uuid,
                        qty: line.getQuantity(),
                        name: line.getFullProductName(),
                        note: line.getCustomerNote(),
                        subtotalFormatted: formatCurrency(
                            line.price_subtotal_incl || 0,
                            this.pos.currency.id
                        ),
                        unitPrice: unitPrice(line),
                        refundedQty: refunded,
                        remaining: Math.max(0, qty - refunded),
                        selected: this.state.koRefundQty[line.uuid] || 0,
                    };
                });
                const fullyRefunded =
                    orderLines.length > 0 && lines.every((info) => info.remaining <= 0);
                const partlyRefunded =
                    !fullyRefunded && lines.some((info) => info.refundedQty > 0);
                const date = new Date(timestamp(order.date_order));
                return {
                    order,
                    lines,
                    no: `#${shortOrderNumber(order)}`,
                    tableName: order.table_id ? `โต๊ะ ${order.table_id.table_number}` : "สั่งกลับบ้าน",
                    timeStr: date.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }),
                    count: orderLines.length,
                    paymentName: order.payment_ids[0]?.payment_method_id?.name || "-",
                    totalFormatted: formatCurrency(order.priceIncl || 0, this.pos.currency.id),
                    isVoid: fullyRefunded || order.isRefund,
                    canRefund: !order.isRefund && !fullyRefunded,
                    statusLabel: order.isRefund
                        ? "รายการคืนเงิน · Refund"
                        : fullyRefunded
                        ? "คืนเงินครบแล้ว · Refunded"
                        : partlyRefunded
                        ? "คืนเงินบางส่วน · Partly refunded"
                        : "ชำระแล้ว · Paid",
                    hasTaxInvoice: Boolean(order.raw.account_move),
                };
            });
    },

    get koSelectedTicket() {
        const uuid = this.state.koSelectedTicketUuid;
        if (!uuid) {
            return null;
        }
        return this.koBilledOrders.find((ticket) => ticket.order.uuid === uuid) || null;
    },

    koOpenTicketSheet(ticket) {
        this.state.koSelectedTicketUuid = ticket.order.uuid;
        this.state.koConfirmVoid = false;
        this.state.koRefundQty = {};
    },

    koCloseTicketSheet() {
        this.state.koSelectedTicketUuid = null;
        this.state.koConfirmVoid = false;
        this.state.koRefundQty = {};
    },

    // ------------------------------------------------------------------
    // Open orders — editing, cancelling, serving
    // ------------------------------------------------------------------

    /**
     * Open an order back up in the sell screen.
     *
     * The KO ticket screen replaces Odoo's whole template, which also threw away
     * `onClickOrder`. Without this there was no way at all to add a dish to an
     * order that was already keyed in — and a takeaway (no table) could not be
     * reached from anywhere, because the ขาย tab sends you to the floor plan.
     */
    async koEditOrder(entry) {
        const order = entry.order || entry;
        if (this.state.koBusy) {
            return;
        }
        if (order.isRefund) {
            // A half-finished refund resumes where it stopped: at the payment.
            this.pos.setOrder(order);
            this.pos.navigate("PaymentScreen", { orderUuid: order.uuid });
            return;
        }
        if (order.finalized) {
            showKoToast("บิลนี้ชำระแล้ว แก้ไขที่แท็บ “บิลแล้ว”");
            return;
        }
        if (this.pos.isOrderSyncing?.(order)) {
            showKoToast("ออเดอร์นี้กำลังบันทึกอยู่ กรุณารอสักครู่");
            return;
        }
        this.state.koBusy = true;
        try {
            if (this.pos.config.isShareable) {
                await this.pos.syncAllOrders();
            }
            this.pos.setOrder(order);
            this.pos.mobile_pane = "right";
            this.pos.ticket_screen_mobile_pane = "left";
            this.pos.navigate("ProductScreen", { orderUuid: order.uuid });
        } catch (error) {
            console.error("KO POS open order for edit failed", error);
            showKoToast("เปิดออเดอร์ไม่สำเร็จ");
        } finally {
            this.state.koBusy = false;
        }
    },

    async _koConfirmKitchenTouch(line, mode) {
        const state = line.koKitchenState || "not_sent";
        if (!KITCHEN_BUSY_STATES.includes(state)) {
            return true;
        }
        return await ask(this.dialog, {
            title: "รายการนี้ส่งครัวไปแล้ว",
            body: `“${line.getFullProductName()}” ${KITCHEN_BUSY_LABEL[state]} — ${
                mode === "remove" ? "ยืนยันลบออกจากออเดอร์?" : "ยืนยันลดจำนวน?"
            } ระบบจะแจ้งจอครัวให้ทันที`,
            confirmLabel: mode === "remove" ? "ลบและแจ้งครัว" : "ยืนยันและแจ้งครัว",
            cancelLabel: "ไม่แก้",
        });
    },

    /** Is this order already showing on the kitchen board? */
    _koIsOnKitchenBoard(order) {
        return order.getOrderlines().some((line) => Boolean(line.koKitchenState));
    },

    /**
     * Odoo's `updateLastOrderChange()` walks `last_order_preparation_change.lines`
     * without checking it exists, and the server hands that field back as a bare
     * `"{}"` for an order that was synced before it was ever sent to preparation
     * — so re-sending such an order throws. Give it the shape Odoo expects
     * before letting Odoo touch it.
     */
    _koNormalisePreparationBookkeeping(order) {
        const bag = order.last_order_preparation_change;
        if (!bag || typeof bag !== "object") {
            order.last_order_preparation_change = { lines: {} };
        } else if (!bag.lines) {
            bag.lines = {};
        }
    },

    /** Push an edit made from this screen to the kitchen and to the server. */
    async _koPersistOrderEdit(order, { wasOnKitchenBoard = false, removed = [] } = {}) {
        if (!order.getOrderlines().length) {
            // An order with nothing left in it is not an order.
            await this._koDeleteOrder(order);
            return;
        }
        if (removed.length) {
            try {
                await this.pos.koCancelKdsLines?.(order, removed);
            } catch (error) {
                console.error("KO KDS line cancellation failed", error);
                showKoToast("แก้ไขแล้ว แต่แจ้งจอครัวไม่สำเร็จ");
            }
        }
        if (wasOnKitchenBoard) {
            this._koNormalisePreparationBookkeeping(order);
            try {
                await this.pos.sendOrderInPreparation(order);
            } catch (error) {
                console.error("KO POS kitchen sync after edit failed", error);
                showKoToast("แก้ไขแล้ว แต่แจ้งจอครัวไม่สำเร็จ");
            }
        }
        try {
            this.pos.addPendingOrder([order.id]);
            await this.pos.syncAllOrders({ orders: [order] });
        } catch (error) {
            console.error("KO POS order sync after edit failed", error);
            showKoToast("แก้ไขแล้ว แต่ยังบันทึกขึ้นระบบไม่สำเร็จ");
        }
    },

    async koStepLineQty(entry, item, delta) {
        const order = entry.order;
        const line = item.line;
        if (this.state.koBusy) {
            return;
        }
        if (order.finalized || order.isRefund) {
            showKoToast("บิลนี้ชำระแล้ว ใช้ “คืนเงิน” ในแท็บบิลแล้วแทน");
            return;
        }
        const nextQuantity = line.getQuantity() + delta;
        if (delta < 0) {
            const confirmed = await this._koConfirmKitchenTouch(
                line,
                nextQuantity <= 0 ? "remove" : "reduce"
            );
            if (!confirmed) {
                return;
            }
        }
        this.state.koBusy = true;
        try {
            order.assertEditable();
            const wasOnKitchenBoard = this._koIsOnKitchenBoard(order);
            const removed = [];
            if (nextQuantity <= 0) {
                // Snapshot before the line disappears — the kitchen still has to
                // be told which dish to strike off.
                removed.push(this.pos.koKdsLineSnapshot?.(line));
                order.removeOrderline(line);
            } else {
                line.setQuantity(nextQuantity, Boolean(line.combo_line_ids?.length));
            }
            await this._koPersistOrderEdit(order, {
                wasOnKitchenBoard,
                removed: removed.filter(Boolean),
            });
        } catch (error) {
            console.error("KO POS quantity change failed", error);
            showKoToast("แก้จำนวนไม่สำเร็จ");
        } finally {
            this.state.koBusy = false;
        }
    },

    async koRemoveLine(entry, item) {
        const order = entry.order;
        const line = item.line;
        if (this.state.koBusy) {
            return;
        }
        if (order.finalized || order.isRefund) {
            showKoToast("บิลนี้ชำระแล้ว ใช้ “คืนเงิน” ในแท็บบิลแล้วแทน");
            return;
        }
        const confirmed = await this._koConfirmKitchenTouch(line, "remove");
        if (!confirmed) {
            return;
        }
        this.state.koBusy = true;
        try {
            order.assertEditable();
            const wasOnKitchenBoard = this._koIsOnKitchenBoard(order);
            const snapshot = this.pos.koKdsLineSnapshot?.(line);
            const label = line.getFullProductName();
            order.removeOrderline(line);
            await this._koPersistOrderEdit(order, {
                wasOnKitchenBoard,
                removed: snapshot ? [snapshot] : [],
            });
            showKoToast(`ลบ “${label}” แล้ว`);
        } catch (error) {
            console.error("KO POS line removal failed", error);
            showKoToast("ลบรายการไม่สำเร็จ");
        } finally {
            this.state.koBusy = false;
        }
    },

    async koCancelOrder(entry) {
        const order = entry.order || entry;
        if (this.state.koBusy) {
            return;
        }
        if (order.finalized) {
            showKoToast("บิลนี้ชำระแล้ว ใช้ “ยกเลิกบิล” ในแท็บบิลแล้ว");
            return;
        }
        const what = order.isRefund
            ? "ทิ้งรายการคืนเงินที่ยังไม่จบนี้?"
            : `ยกเลิกออเดอร์ ${entry.no || shortOrderNumber(order)} ทั้งใบ? รายการที่ส่งครัวไปแล้วจะถูกแจ้งยกเลิกด้วย`;
        const confirmed = await ask(this.dialog, {
            title: order.isRefund ? "ทิ้งรายการคืนเงิน" : "ยกเลิกออเดอร์",
            body: what,
            confirmLabel: order.isRefund ? "ทิ้งรายการนี้" : "ยกเลิกออเดอร์",
            cancelLabel: "ไม่ยกเลิก",
        });
        if (!confirmed) {
            return;
        }
        this.state.koBusy = true;
        try {
            await this._koDeleteOrder(order);
            showKoToast(order.isRefund ? "ทิ้งรายการคืนเงินแล้ว" : "ยกเลิกออเดอร์แล้ว");
        } finally {
            this.state.koBusy = false;
        }
    },

    async _koDeleteOrder(order) {
        // Tell the kitchen directly as well as through Odoo's cancel path: KDS
        // tickets are created straight from the browser, so an order can have a
        // live ticket while `order.isSynced` is still false — and in that case
        // Odoo's own cancel branch never runs.
        if (!order.isRefund) {
            try {
                await this.pos.data.call("ko.kds.ticket", "cancel_by_order_uuid", [
                    order.uuid,
                    this.pos.config.id,
                ]);
            } catch (error) {
                console.error("KO KDS cancel on order delete failed", error);
                showKoToast("ยกเลิกออเดอร์แล้ว แต่จอครัวยังไม่อัปเดต");
            }
        }
        try {
            await this.pos.deleteOrders([order], [], order.isRefund);
        } catch (error) {
            console.error("KO POS order delete failed", error);
            showKoToast("ยกเลิกออเดอร์ไม่สำเร็จ");
        }
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

    // ------------------------------------------------------------------
    // Billed orders — reprint, invoice, refund
    // ------------------------------------------------------------------

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

    // --- partial refund selection -------------------------------------

    koRefundQtyFor(lineUuid) {
        return this.state.koRefundQty[lineUuid] || 0;
    },

    koStepRefundQty(item, delta) {
        const current = this.koRefundQtyFor(item.uuid);
        const next = Math.min(item.remaining, Math.max(0, current + delta));
        this.state.koRefundQty = { ...this.state.koRefundQty, [item.uuid]: next };
        this.state.koConfirmVoid = false;
    },

    koSelectWholeBill() {
        const ticket = this.koSelectedTicket;
        if (!ticket) {
            return;
        }
        const selection = {};
        for (const item of ticket.lines) {
            if (item.remaining > 0) {
                selection[item.uuid] = item.remaining;
            }
        }
        this.state.koRefundQty = selection;
    },

    koClearRefundSelection() {
        this.state.koRefundQty = {};
    },

    get koRefundSelectedQty() {
        const ticket = this.koSelectedTicket;
        if (!ticket) {
            return 0;
        }
        return ticket.lines.reduce((total, item) => total + this.koRefundQtyFor(item.uuid), 0);
    },

    get koRefundSelectedAmount() {
        const ticket = this.koSelectedTicket;
        if (!ticket) {
            return 0;
        }
        return ticket.lines.reduce(
            (total, item) => total + item.unitPrice * this.koRefundQtyFor(item.uuid),
            0
        );
    },

    get koRefundSelectedFormatted() {
        return formatCurrency(this.koRefundSelectedAmount, this.pos.currency.id);
    },

    get koIsWholeBillSelected() {
        const ticket = this.koSelectedTicket;
        if (!ticket) {
            return false;
        }
        const refundable = ticket.lines.filter((item) => item.remaining > 0);
        return (
            refundable.length > 0 &&
            refundable.every((item) => this.koRefundQtyFor(item.uuid) === item.remaining)
        );
    },

    // --- refund execution ---------------------------------------------

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

    /**
     * Throw away refunds of this bill that were started and never paid.
     *
     * Two separate traps make this necessary. Odoo stamps every staged line with
     * `destination_order_uuid` the moment a refund order is created, and
     * `_getRefundableDetails` then skips those lines forever — so a second
     * attempt produces a refund order with no lines and a ฿0 total. And the
     * abandoned draft itself keeps counting towards `refundedQty`, which is what
     * made a bill read "คืนเงินครบแล้ว" with the money still in the drawer.
     */
    async _koDropPendingRefunds(sourceOrder) {
        const stale = this.pos.models["pos.order"].filter(
            (order) =>
                order.isRefund &&
                !order.finalized &&
                order
                    .getOrderlines()
                    .some((line) => line.refunded_orderline_id?.order_id?.uuid === sourceOrder.uuid)
        );
        for (const order of stale) {
            try {
                await this.pos.deleteOrders([order], [], true);
                try {
                    sessionStorage.removeItem(`ko_pos_refund_intent_${order.uuid}`);
                } catch {
                    // Browser storage being unavailable must not stop the refund.
                }
            } catch (error) {
                console.error("KO POS could not drop an unfinished refund", error);
            }
        }
        if (this.pos.koRefundIntent?.sourceOrderUuid === sourceOrder.uuid) {
            this.pos.koRefundIntent = null;
        }
    },

    /**
     * @param {"partial"|"full"|"edit"} mode
     */
    async _koStartRefund(mode) {
        const ticket = this.koSelectedTicket;
        if (!ticket || this.state.koBusy) {
            return;
        }
        const order = ticket.order;
        this.state.koBusy = true;
        try {
            await this._koDropPendingRefunds(order);

            // Re-stage from scratch. Leaving stale details behind is what made
            // repeat refunds silently refund the wrong quantity.
            const lineToRefund = order.uiState.lineToRefund;
            for (const key of Object.keys(lineToRefund)) {
                delete lineToRefund[key];
            }

            let staged = 0;
            for (const item of ticket.lines) {
                const wanted =
                    mode === "partial"
                        ? Math.min(item.remaining, this.koRefundQtyFor(item.uuid))
                        : item.remaining;
                if (wanted > 0) {
                    this.getToRefundDetail(item.line).qty = wanted;
                    staged += wanted;
                }
            }
            if (!staged) {
                showKoToast(
                    mode === "partial" ? "ยังไม่ได้เลือกรายการที่จะคืน" : "บิลนี้คืนเงินครบแล้ว"
                );
                return;
            }

            // Odoo reads the refund off the *selected* order in the ticket screen.
            this.setSelectedOrder(order);
            const firstLine = order.getOrderlines()[0];
            if (firstLine) {
                this.state.selectedOrderlineIds[order.id] = firstLine.id;
            }

            this.pos.koRefundIntent = {
                type: mode,
                sourceOrderUuid: order.uuid,
                tableId: order.table_id?.id || null,
                partnerId: order.getPartner()?.id || null,
                paymentMethodId: order.payment_ids[0]?.payment_method_id?.id || null,
                // Only a full-bill edit reopens the sale; a partial refund
                // leaves the original bill exactly as it is.
                lines: mode === "edit" ? this._koReplacementLines(order) : [],
                refundOrderUuid: null,
            };

            await this.onDoRefund();

            const refundOrder = this.pos.getOrder();
            if (!refundOrder?.isRefund) {
                this.pos.koRefundIntent = null;
                showKoToast("สร้างรายการคืนเงินไม่สำเร็จ");
                return;
            }
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
                console.warn("KO POS could not persist refund intent", error);
            }
            this.koCloseTicketSheet();
            showKoToast(
                mode === "edit"
                    ? "คืนเงินบิลเดิมให้เสร็จก่อน แล้วระบบจะโหลดรายการเดิมมาให้แก้"
                    : "สร้างรายการคืนเงินแล้ว กรุณาตรวจสอบและรับเงินคืน"
            );
        } catch (error) {
            console.error("KO POS refund failed", error);
            this.pos.koRefundIntent = null;
            showKoToast("เริ่มรายการคืนเงินไม่สำเร็จ");
        } finally {
            this.state.koBusy = false;
        }
    },

    koRefundSelected() {
        return this._koStartRefund("partial");
    },

    koEditBill() {
        return this._koStartRefund("edit");
    },

    koVoidBill() {
        if (!this.koSelectedTicket) {
            return;
        }
        if (!this.state.koConfirmVoid) {
            this.state.koConfirmVoid = true;
            return;
        }
        return this._koStartRefund("full");
    },

    /**
     * Never turn a live table into a refund.
     *
     * Base Odoo reuses *any* empty draft order as the refund's destination. In a
     * restaurant the most common empty draft order is the one a waiter just
     * created by tapping a table — so refunding a bill could quietly convert
     * table 5's fresh order into a refund. Only reuse orders nobody is sitting at.
     */
    _getEmptyOrder(partner) {
        let emptyOrderForPartner = null;
        let emptyOrder = null;
        for (const order of this.pos.models["pos.order"].filter(
            (order) =>
                !order.finalized &&
                !order.table_id &&
                !order.isRefund &&
                order.getOrderlines().length === 0 &&
                order.payment_ids.length === 0
        )) {
            if (order.getPartner() === partner) {
                emptyOrderForPartner = order;
                break;
            } else if (!order.getPartner() && emptyOrder === null) {
                emptyOrder = order;
            }
        }
        return (
            emptyOrderForPartner || emptyOrder || this.pos.addNewOrder({ partner_id: partner })
        );
    },
});
