/** @odoo-module **/

import { patch } from "@web/core/utils/patch";
import { PosStore } from "@point_of_sale/app/services/pos_store";
import { getOrderChanges } from "@point_of_sale/app/models/utils/order_change";
import OrderPaymentValidation from "@point_of_sale/app/utils/order_payment_validation";
import { setKitchenAlertAckHandler, setKitchenAlerts } from "./kds_alert";

/**
 * KO KDS — POS side.
 *
 * Three things happen here.
 *
 * 1. The kitchen display is decoupled from `pos.printer`. Odoo decides whether
 *    an order "has something to send" from the categories attached to a
 *    receipt printer, so a shop with no kitchen printer (or a printer that does
 *    not list เครื่องดื่ม) never even sees the ส่งครัว button. KDS routing is
 *    configured on ko.kds.station instead, so every POS category counts.
 *
 * 2. Both ways of taking an order reach the kitchen:
 *    - key the dishes, press ส่งครัว  → Odoo's own submitOrder path;
 *    - key the dishes and pay straight away → sent automatically the moment
 *      payment validates. Odoo only did that outside restaurant mode; in
 *      restaurant mode it asked a yes/no question *before* payment that staff
 *      could dismiss, leaving a paid order the kitchen never saw.
 *
 * 3. Problems reported by a station come back as a red bar plus a chime that
 *    stays until front of house acknowledges it.
 */
patch(PosStore.prototype, {
    async setup() {
        await super.setup(...arguments);
        // Listen only to this POS's kitchen channel — another shop's kitchen
        // activity must not trigger a refresh here.
        this.bus.addChannel(`ko_pos_kds_${this.config.id}`);
        this.bus.subscribe("ko_pos_kds_update", () => this.koRefreshKdsStatus());
        setKitchenAlertAckHandler((items) => this.koAckKitchenIssues(items));
        await this.koRefreshKdsStatus();
    },

    get koKdsEnabled() {
        return this.config.ko_kds_enabled !== false;
    },

    /** Every POS category. KDS station routing happens on the server. */
    get koKdsCategoryIds() {
        return new Set(this.models["pos.category"].map((categ) => categ.id));
    },

    /**
     * Odoo asks this for "what has changed since the last send", and uses the
     * answer for the ส่งครัว button and for order.hasChange. Base Odoo scopes it
     * to printer categories; with a KDS every category is a preparation
     * category, otherwise drink-only orders can never be fired.
     */
    getOrderChanges(order = this.getOrder()) {
        if (this.koKdsEnabled) {
            return getOrderChanges(order, this.koKdsCategoryIds);
        }
        return super.getOrderChanges(order);
    },

    /**
     * Our own diff, independent of any category configuration.
     *
     * Two reasons not to reuse `changesToOrder`: it drops products that have no
     * POS category at all, and it reports a *delta* quantity while the KDS
     * ticket stores the line's absolute quantity — so adding one more plate to
     * a table used to overwrite "3" with "1" on the kitchen screen.
     */
    koKdsChanges(order, cancelled = false) {
        const last = order.last_order_preparation_change?.lines || {};
        const added = [];
        const removed = [];

        const asPayload = (line) => ({
            uuid: line.uuid,
            product_id: line.getProduct()?.id,
            name: line.getFullProductName(),
            display_name: line.getProduct()?.display_name,
            quantity: line.getQuantity(),
            note: line.getNote(),
            customer_note: line.getCustomerNote(),
            attribute_value_names: (line.attribute_value_ids || []).map((a) => a.name),
        });

        if (cancelled) {
            for (const change of Object.values(last)) {
                removed.push({ ...change, quantity: Math.abs(change.quantity || 0) });
            }
            return { new: [], cancelled: removed };
        }

        const liveUuids = new Set();
        for (const line of order.getOrderlines()) {
            liveUuids.add(line.uuid);
            const previous = last[line.preparationKey];
            const qty = line.getQuantity();
            if (qty <= 0) {
                continue;
            }
            const changed =
                !previous ||
                previous.quantity !== qty ||
                (previous.note || "") !== (line.getNote() || "") ||
                (previous.customer_note || "") !== (line.getCustomerNote() || "");
            if (changed) {
                added.push(asPayload(line));
            }
        }

        for (const change of Object.values(last)) {
            if (!liveUuids.has(change.uuid)) {
                removed.push({ ...change, quantity: Math.abs(change.quantity || 0) });
            }
        }

        return { new: added, cancelled: removed };
    },

    /**
     * The ส่งครัว button only renders when this returns something. Base Odoo
     * returns nothing for a product with no POS category, so add a fallback
     * bucket rather than hiding the button on an order the kitchen still needs.
     */
    getCategoryCount(order = this.getOrder()) {
        const result = super.getCategoryCount(order);
        if (result.length || !this.koKdsEnabled || !order) {
            return result;
        }
        const change = this.koKdsChanges(order);
        const count = change.new.reduce((total, line) => total + (line.quantity || 0), 0);
        if (count > 0) {
            return [{ count, name: "ครัว" }];
        }
        return result;
    },

    /**
     * Base restaurant Odoo pops "the order has not been sent, send it?" before
     * payment, and Discard silently skips the kitchen. With auto-send after
     * payment configured there is nothing to ask.
     */
    async _askForPreparation() {
        if (this.koKdsEnabled && this.config.ko_kds_auto_send_on_payment !== false) {
            return;
        }
        return await super._askForPreparation(...arguments);
    },

    koKdsPayload(order, change) {
        const partner = order.getPartner?.();
        return {
            order_uuid: order.uuid,
            pos_reference: order.pos_reference,
            tracking_number: order.tracking_number,
            config_id: this.config.id,
            table: order.table_id ? order.table_id.table_number : null,
            floor: order.table_id?.floor_id?.name || "",
            customer_name: partner?.name || order.partner_name || "",
            paid: Boolean(order.finalized || order.isPaid?.()),
            internal_note: order.internal_note || "",
            general_customer_note: order.general_customer_note || "",
            new: change.new,
            cancelled: change.cancelled,
        };
    },

    async koSendToKds(order, opts = {}) {
        if (!this.koKdsEnabled || !order || order.isRefund || order.uiState?.isReprinting) {
            return false;
        }
        let payload = null;
        try {
            const change = this.koKdsChanges(order, Boolean(opts.cancelled));
            if (!change.new.length && !change.cancelled.length) {
                return false;
            }
            payload = this.koKdsPayload(order, change);
        } catch (error) {
            console.warn("KDS: failed computing changes", error);
            return false;
        }
        try {
            await this.data.call("ko.kds.ticket", "create_from_pos", [payload]);
            this.koMarkKitchenDirty(order);
            await this.koRefreshKdsStatus();
            return true;
        } catch (error) {
            // Offline or server error: the kitchen printer (if any) still got it.
            console.warn("KDS: failed sending ticket", error);
            return false;
        }
    },

    /**
     * Snapshot what the kitchen needs to strike a dish off, before front of
     * house deletes the line and the object is gone.
     */
    koKdsLineSnapshot(line) {
        return { uuid: line.uuid, qty: Math.abs(line.getQuantity()) };
    },

    /**
     * Cancel named dishes on the kitchen board.
     *
     * `koKdsChanges` can only report a removal it can still see in
     * `last_order_preparation_change`, and that bookkeeping comes back from the
     * server as a bare `{}` for any order that was synced before it was sent to
     * preparation — so a dish deleted from an order kept cooking on the kitchen
     * screen forever. Front of house passes the lines it removed instead of
     * relying on Odoo remembering them.
     *
     * The quantities go to `cancel_lines_from_pos`, which knows how to take
     * part of a plate off the board rather than all of it.
     */
    async koCancelKdsLines(order, lines) {
        if (!this.koKdsEnabled || !order || order.isRefund || !lines?.length) {
            return false;
        }
        try {
            await this.data.call("ko.kds.ticket", "cancel_lines_from_pos", [
                order.uuid,
                lines,
                this.config.id,
            ]);
            this.koMarkKitchenDirty(order);
            await this.koRefreshKdsStatus();
            return true;
        } catch (error) {
            console.warn("KDS: failed cancelling removed lines", error);
            return false;
        }
    },

    /**
     * A refund has just been validated: take the returned dishes off the
     * kitchen board. Only what was actually refunded is removed, so refunding
     * one plate out of four leaves the other three cooking.
     *
     * This deliberately hangs off order validation rather than off a button.
     * The KO payment screen only covers part of Odoo's template, so a till on
     * a wide screen validates through Odoo's own button — anything wired to a
     * KO button alone silently never runs there.
     */
    async koCancelKitchenForRefund(order) {
        if (!this.koKdsEnabled || !order?.isRefund) {
            return false;
        }
        const bySource = {};
        for (const line of order.getOrderlines()) {
            const source = line.refunded_orderline_id;
            const sourceOrder = source?.order_id;
            if (!source || !sourceOrder?.uuid) {
                continue;
            }
            const bucket = (bySource[sourceOrder.uuid] = bySource[sourceOrder.uuid] || []);
            bucket.push({ uuid: source.uuid, qty: Math.abs(line.getQuantity()) });
        }
        const sources = Object.keys(bySource);
        if (!sources.length) {
            return false;
        }
        for (const orderUuid of sources) {
            try {
                await this.data.call("ko.kds.ticket", "cancel_lines_from_pos", [
                    orderUuid,
                    bySource[orderUuid],
                    this.config.id,
                ]);
            } catch (error) {
                console.warn("KDS: failed cancelling refunded dishes", error);
            }
            this.koMarkKitchenDirty(this.models["pos.order"].getBy("uuid", orderUuid));
        }
        await this.koRefreshKdsStatus();
        return true;
    },

    async sendOrderInPreparation(order, opts = {}) {
        if (!opts.byPassPrint) {
            // Send to KDS first — the (optional) kitchen printer may be slow.
            await this.koSendToKds(order, opts);
        }
        return await super.sendOrderInPreparation(order, opts);
    },

    // ------------------------------------------------------------------
    // Kitchen state coming back to front of house
    // ------------------------------------------------------------------

    /**
     * Orders the kitchen could still have something to say about.
     *
     * Asking about *every* order in memory meant the payload grew all day — by
     * the sixtieth bill the orders tab was posting sixty uuids on every open and
     * on every bus notification, to be told sixty times that a bill served two
     * hours ago is still served. An order drops out once we have checked it and
     * it has nothing live left; anything that touches the kitchen afterwards
     * marks it dirty again.
     */
    koKdsWatchedOrders() {
        return this.models["pos.order"].getAll().filter((order) => {
            if (order.isRefund || order.isEmpty()) {
                return false;
            }
            if (!order.finalized) {
                return true;
            }
            if (!order.koKitchenChecked) {
                return true;
            }
            return order
                .getOrderlines()
                .some(
                    (line) =>
                        line.koKitchenState &&
                        !["served", "cancelled"].includes(line.koKitchenState)
                );
        });
    },

    /** This order's kitchen state is out of date — look at it again. */
    koMarkKitchenDirty(order) {
        if (order) {
            order.koKitchenChecked = false;
        }
    },

    async koRefreshKdsStatus() {
        const orders = this.koKdsWatchedOrders();
        if (!orders.length) {
            return;
        }
        try {
            const status = await this.data.call(
                "ko.kds.ticket",
                "get_pos_status",
                [orders.map((order) => order.uuid), this.config.id]
            );
            const alerts = [];
            for (const order of orders) {
                // Answered for. Whether or not the kitchen knows this order, we
                // now have its state and need not ask again until something
                // touches it (koMarkKitchenDirty).
                order.koKitchenChecked = true;
                const orderStatus = status[order.uuid];
                if (!orderStatus) {
                    for (const line of order.getOrderlines()) {
                        line.koKitchenState = line.koKitchenState || null;
                    }
                    continue;
                }
                order.koKitchenTicket = orderStatus.ticket_name || null;
                order.koKitchenState = orderStatus.ticket_state || null;
                for (const line of order.getOrderlines()) {
                    const lineStatus = orderStatus.lines[line.uuid];
                    const state =
                        typeof lineStatus === "string" ? lineStatus : lineStatus?.state;
                    line.koServed = state === "served";
                    line.koKitchenState = state || null;
                    line.koKitchenStation =
                        typeof lineStatus === "object" ? lineStatus?.station : null;
                    line.koKitchenIssue =
                        typeof lineStatus === "object" ? lineStatus?.issue || null : null;
                    if (line.koKitchenIssue && !line.koKitchenIssue.ack) {
                        alerts.push({
                            key: `${order.uuid}|${line.uuid}|${line.koKitchenIssue.time || ""}`,
                            orderUuid: order.uuid,
                            lineUuid: line.uuid,
                            orderLabel: order.table_id
                                ? `โต๊ะ ${order.table_id.table_number}`
                                : order.getPartner?.()?.name || `ออเดอร์ ${order.tracking_number || ""}`,
                            dish: line.getFullProductName(),
                            label: line.koKitchenIssue.label,
                            note: line.koKitchenIssue.note,
                        });
                    }
                }
            }
            setKitchenAlerts(alerts);
        } catch (error) {
            console.warn("KDS: failed refreshing front-of-house state", error);
        }
    },

    async koAckKitchenIssues(items) {
        const byOrder = {};
        for (const item of items || []) {
            (byOrder[item.orderUuid] = byOrder[item.orderUuid] || []).push(item.lineUuid);
        }
        for (const [orderUuid, lineUuids] of Object.entries(byOrder)) {
            try {
                await this.data.call("ko.kds.ticket", "ack_issues_from_pos", [
                    orderUuid,
                    lineUuids,
                ]);
            } catch (error) {
                console.warn("KDS: failed acknowledging kitchen issue", error);
            }
        }
        await this.koRefreshKdsStatus();
    },
});

/**
 * Path 2 of the owner's spec: key the dishes, take the money, and the kitchen
 * gets the order the instant the payment succeeds. Odoo skips this in
 * restaurant mode, which is why paid orders could vanish before the kitchen.
 */
patch(OrderPaymentValidation.prototype, {
    async afterOrderValidation() {
        const result = await super.afterOrderValidation(...arguments);
        const pos = this.pos;
        const order = this.order;
        if (order?.isRefund && pos?.koKdsEnabled) {
            // Money went back to the customer: the kitchen must stop cooking
            // whatever was returned. Doing it here rather than in the KO
            // payment screen matters — a wide screen validates through Odoo's
            // own button, which never runs KO's handler.
            try {
                await pos.koCancelKitchenForRefund(order);
            } catch (error) {
                console.warn("KDS: refund cancellation failed", error);
            }
            return result;
        }
        if (
            pos?.config?.module_pos_restaurant &&
            pos.koKdsEnabled &&
            pos.config.ko_kds_auto_send_on_payment !== false &&
            order &&
            !order.isRefund
        ) {
            try {
                await pos.checkPreparationStateAndSentOrderInPreparation(order, {
                    orderDone: true,
                });
            } catch (error) {
                // Never let a kitchen hand-off failure block the receipt screen.
                console.warn("KDS: auto-send after payment failed", error);
                try {
                    await pos.koSendToKds(order);
                } catch (fallbackError) {
                    console.warn("KDS: fallback send after payment failed", fallbackError);
                }
            }
        }
        return result;
    },
});
