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

/**
 * How much of a line the customer has actually been paid back for.
 *
 * Odoo's own `line.refundedQty` counts refund lines whose order is merely
 * *drafted* — so the instant someone taps ยกเลิกบิล the original bill looked
 * fully refunded even though no money had moved, and the bill's whole action
 * grid disappeared. Only a finalised refund counts as money returned.
 */
function settledRefundQty(line) {
    return (line.refund_orderline_ids || []).reduce(
        (total, refundLine) =>
            refundLine.order_id?.finalized && refundLine.order_id?.state !== "cancel"
                ? total - refundLine.qty
                : total,
        0
    );
}

/** A refund for this bill that was started and never finished. */
function pendingRefundOrder(order) {
    for (const line of order.getOrderlines()) {
        for (const refundLine of line.refund_orderline_ids || []) {
            const refundOrder = refundLine.order_id;
            if (refundOrder && !refundOrder.finalized && refundOrder.state !== "cancel") {
                return refundOrder;
            }
        }
    }
    return null;
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
            koConfirmCancelUuid: null,
            koBusy: false,
            // uuid of the source orderline -> how many units to refund
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
        return this.koAllOrders
            .filter((order) => {
                if (order.isEmpty() || order.isRefund) {
                    return false;
                }
                if (!order.finalized) {
                    return true;
                }
                // A bill that has been paid back in full is finished business:
                // it must not sit here offering เสิร์ฟ buttons for food nobody
                // is going to make.
                const settled = order
                    .getOrderlines()
                    .every((line) => settledRefundQty(line) >= Math.abs(line.qty));
                if (settled) {
                    return false;
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
                    // An unpaid order is still a working document: staff must be
                    // able to walk back into it to add or remove a dish. A paid
                    // one is a bill — changing it means refunding it.
                    canEdit: !order.finalized,
                    confirmCancel: this.state.koConfirmCancelUuid === order.uuid,
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
            .map((order) => this._koBillTicket(order));
    },

    _koBillTicket(order) {
        const lines = order.getOrderlines();
        const fullyRefunded = lines.every(
            (line) => settledRefundQty(line) >= Math.abs(line.qty)
        );
        const partlyRefunded =
            !fullyRefunded && lines.some((line) => settledRefundQty(line) > 0);
        const pending = order.isRefund ? null : pendingRefundOrder(order);
        const date = new Date(timestamp(order.date_order));
        return {
            order,
            no: `#${shortOrderNumber(order)}`,
            tableName: order.table_id ? `โต๊ะ ${order.table_id.table_number}` : "สั่งกลับบ้าน",
            timeStr: date.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }),
            count: lines.length,
            paymentName: order.payment_ids[0]?.payment_method_id?.name || "-",
            totalFormatted: formatCurrency(order.priceIncl || 0, this.pos.currency.id),
            isVoid: fullyRefunded || order.isRefund,
            // A refund that was started and abandoned blocks a second attempt,
            // so it gets its own banner instead of silently locking the bill.
            pendingRefund: pending,
            pendingRefundLabel: pending
                ? `มีบิลคืนเงินค้างอยู่ ${formatCurrency(
                      Math.abs(pending.priceIncl || 0),
                      this.pos.currency.id
                  )} — ยังไม่ได้จ่ายคืนลูกค้า`
                : "",
            statusLabel: order.isRefund
                ? "รายการคืนเงิน · Refund"
                : fullyRefunded
                ? "คืนเงินครบแล้ว · Refunded"
                : partlyRefunded
                ? "คืนเงินบางส่วน · Partly refunded"
                : "ชำระแล้ว · Paid",
            hasTaxInvoice: Boolean(order.raw.account_move),
            lines: lines.map((line) => {
                const total = Math.abs(line.qty);
                const settled = settledRefundQty(line);
                return {
                    line,
                    uuid: line.uuid,
                    qty: line.getQuantity(),
                    name: line.getFullProductName(),
                    note: line.getCustomerNote(),
                    subtotal: line.price_subtotal_incl,
                    refundable: Math.max(0, total - settled),
                    settled,
                };
            }),
        };
    },

    koOpenTicketSheet(ticket) {
        this.state.koSelectedTicket = ticket;
        this.state.koConfirmVoid = false;
        this.state.koRefundQty = {};
    },

    koCloseTicketSheet() {
        this.state.koSelectedTicket = null;
        this.state.koConfirmVoid = false;
        this.state.koRefundQty = {};
    },

    // ------------------------------------------------------------------
    // Open orders: edit and cancel
    // ------------------------------------------------------------------

    async koEditOrder(order) {
        // `setOrder` is TicketScreen's own helper: it refuses while the order is
        // syncing, flushes shared orders first, then selects it and lands on the
        // right screen. Before this, the ออเดอร์ค้าง cards had no click handler
        // at all, so a takeaway with no table could never be reopened.
        if (this.state.koBusy || order.finalized) {
            return;
        }
        this.state.koBusy = true;
        try {
            await this.setOrder(order);
        } catch (error) {
            console.error("KO POS could not open order", error);
            showKoToast("เปิดออเดอร์ไม่สำเร็จ กรุณาลองอีกครั้ง");
        } finally {
            this.state.koBusy = false;
        }
    },

    /**
     * Delete an order without Odoo's own confirmation dialog.
     *
     * `pos.onDeleteOrder` opens an English "are you sure" prompt of its own.
     * Both KO screens have already asked, in Thai, so this repeats the rest of
     * its work minus the second prompt — including clearing the lineToRefund
     * entries a deleted refund order leaves behind on the bill it refunded.
     * `deleteOrders` is what tells the kitchen: for an order already sent to
     * preparation it fires sendOrderInPreparation({cancelled: true}) first.
     */
    async _koDeleteOrder(order) {
        const refundedOrderLines = order.lines
            .filter((line) => line.refunded_orderline_id?.order_id)
            .map((line) => ({
                order: line.refunded_orderline_id.order_id,
                uuid: line.refunded_orderline_id.uuid,
            }));
        const deleted = await this.pos.deleteOrders([order]);
        if (!deleted) {
            return false;
        }
        order.uiState.displayed = false;
        for (const refundedLine of refundedOrderLines) {
            delete refundedLine.order?.uiState?.lineToRefund[refundedLine.uuid];
        }
        await this.pos.afterOrderDeletion();
        return true;
    },

    async koCancelOrder(order) {
        if (this.state.koBusy || order.finalized) {
            return;
        }
        if (this.state.koConfirmCancelUuid !== order.uuid) {
            this.state.koConfirmCancelUuid = order.uuid;
            return;
        }
        this.state.koConfirmCancelUuid = null;
        this.state.koBusy = true;
        try {
            const deleted = await this._koDeleteOrder(order);
            showKoToast(deleted ? "ยกเลิกออเดอร์แล้ว" : "ยกเลิกออเดอร์ไม่สำเร็จ");
        } catch (error) {
            console.error("KO POS could not cancel order", error);
            showKoToast("ยกเลิกออเดอร์ไม่สำเร็จ");
        } finally {
            this.state.koBusy = false;
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

    // ------------------------------------------------------------------
    // Refunds
    // ------------------------------------------------------------------

    koRefundQtyOf(item) {
        const value = this.state.koRefundQty[item.uuid];
        return typeof value === "number" ? value : 0;
    },

    koStepRefund(item, delta) {
        const next = Math.min(item.refundable, Math.max(0, this.koRefundQtyOf(item) + delta));
        this.state.koRefundQty = { ...this.state.koRefundQty, [item.uuid]: next };
        this.state.koConfirmVoid = false;
    },

    koSelectAllForRefund() {
        const ticket = this.koSelectedTicket;
        if (!ticket) {
            return;
        }
        const next = {};
        for (const item of ticket.lines) {
            next[item.uuid] = item.refundable;
        }
        this.state.koRefundQty = next;
    },

    get koRefundSelectedCount() {
        const ticket = this.koSelectedTicket;
        if (!ticket) {
            return 0;
        }
        return ticket.lines.reduce((total, item) => total + this.koRefundQtyOf(item), 0);
    },

    get koRefundSelectedTotal() {
        const ticket = this.koSelectedTicket;
        if (!ticket) {
            return formatCurrency(0, this.pos.currency.id);
        }
        const amount = ticket.lines.reduce((total, item) => {
            const qty = this.koRefundQtyOf(item);
            if (!qty) {
                return total;
            }
            const unit = Math.abs(item.qty) ? item.subtotal / Math.abs(item.qty) : 0;
            return total + unit * qty;
        }, 0);
        return formatCurrency(amount, this.pos.currency.id);
    },

    /**
     * Start a refund for exactly the quantities in `wanted`.
     *
     * Odoo keeps refund intentions in `order.uiState.lineToRefund` and its
     * `_getRefundableDetails` skips any entry already bound to a destination
     * order. An abandoned refund therefore poisons every later attempt — the
     * next one comes out as an empty bill for 0 บาท. Clearing the map first is
     * safe because a *pending* refund is refused above, so nothing that is
     * still live can be dropped here.
     */
    async _koStartRefund(wanted) {
        const ticket = this.koSelectedTicket;
        if (!ticket || this.state.koBusy) {
            return;
        }
        const order = ticket.order;
        if (ticket.pendingRefund) {
            showKoToast("บิลนี้มีรายการคืนเงินค้างอยู่ กรุณาทำให้จบหรือทิ้งก่อน");
            return;
        }
        const totalQty = Object.values(wanted).reduce((sum, qty) => sum + qty, 0);
        if (!totalQty) {
            showKoToast("กรุณาเลือกรายการที่จะคืนเงินก่อน");
            return;
        }

        order.uiState.lineToRefund = {};
        this.setSelectedOrder(order);
        const firstLine = order.getOrderlines()[0];
        if (firstLine) {
            this.state.selectedOrderlineIds[order.id] = firstLine.id;
        }
        for (const line of order.getOrderlines()) {
            const detail = this.getToRefundDetail(line);
            detail.qty = wanted[line.uuid] || 0;
        }

        this.state.koBusy = true;
        try {
            await this.onDoRefund();
            const refundOrder = this.pos.getOrder();
            if (refundOrder?.isRefund) {
                this.koCloseTicketSheet();
                showKoToast("สร้างรายการคืนเงินแล้ว กรุณากดยืนยันเพื่อจ่ายคืนลูกค้า");
            } else {
                showKoToast("สร้างรายการคืนเงินไม่สำเร็จ");
            }
        } catch (error) {
            console.error("KO POS refund failed", error);
            showKoToast("สร้างรายการคืนเงินไม่สำเร็จ");
        } finally {
            this.state.koBusy = false;
        }
    },

    koRefundSelected() {
        const ticket = this.koSelectedTicket;
        if (!ticket) {
            return;
        }
        const wanted = {};
        for (const item of ticket.lines) {
            const qty = this.koRefundQtyOf(item);
            if (qty) {
                wanted[item.uuid] = qty;
            }
        }
        return this._koStartRefund(wanted);
    },

    koVoidBill() {
        const ticket = this.koSelectedTicket;
        if (!ticket) {
            return;
        }
        if (!this.state.koConfirmVoid) {
            this.state.koConfirmVoid = true;
            return;
        }
        this.state.koConfirmVoid = false;
        const wanted = {};
        for (const item of ticket.lines) {
            if (item.refundable) {
                wanted[item.uuid] = item.refundable;
            }
        }
        if (!Object.keys(wanted).length) {
            showKoToast("บิลนี้คืนเงินครบแล้ว");
            return;
        }
        return this._koStartRefund(wanted);
    },

    async koResumeRefund() {
        const ticket = this.koSelectedTicket;
        if (!ticket?.pendingRefund || this.state.koBusy) {
            return;
        }
        this.state.koBusy = true;
        try {
            this.koCloseTicketSheet();
            await this.setOrder(ticket.pendingRefund);
        } catch (error) {
            console.error("KO POS could not resume refund", error);
            showKoToast("เปิดบิลคืนเงินไม่สำเร็จ");
        } finally {
            this.state.koBusy = false;
        }
    },

    async koDiscardRefund() {
        const ticket = this.koSelectedTicket;
        if (!ticket?.pendingRefund || this.state.koBusy) {
            return;
        }
        const confirmed = await ask(this.dialog, {
            title: "ทิ้งบิลคืนเงินที่ค้างอยู่?",
            body: "ยังไม่มีเงินคืนให้ลูกค้า บิลเดิมจะกลับมาคืนเงินใหม่ได้",
            confirmLabel: "ทิ้งบิลคืนเงิน",
            cancelLabel: "เก็บไว้ก่อน",
        });
        if (!confirmed) {
            return;
        }
        this.state.koBusy = true;
        try {
            await this._koDeleteOrder(ticket.pendingRefund);
            this.state.koSelectedTicket = this._koBillTicket(ticket.order);
            this.state.koRefundQty = {};
            showKoToast("ทิ้งบิลคืนเงินแล้ว");
        } catch (error) {
            console.error("KO POS could not discard refund", error);
            showKoToast("ทิ้งบิลคืนเงินไม่สำเร็จ");
        } finally {
            this.state.koBusy = false;
        }
    },
});
