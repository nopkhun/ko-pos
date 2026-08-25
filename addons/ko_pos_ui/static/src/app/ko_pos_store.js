/** @odoo-module **/

import { patch } from "@web/core/utils/patch";
import { PosStore } from "@point_of_sale/app/services/pos_store";

/** Don't re-run the whole server refresh more often than this. */
const REFRESH_INTERVAL = 8000;

patch(PosStore.prototype, {
    /**
     * Refresh orders from the server without making anyone wait for it.
     *
     * `TicketScreen.onWillStart` awaits this, and OWL paints nothing until every
     * `onWillStart` resolves — so tapping บิล froze on the previous screen for
     * the whole round trip. In restaurant mode that is not one round trip but
     * three: `syncAllOrders({table_ids})`, `syncAllOrders()` again from the base
     * implementation, and `loadServerOrders()` for the draft orders. Measured at
     * 120 ms RTT with 67 bills in the session, the orders tab took ~1.35 s to
     * show anything, every single time.
     *
     * The screen already has every order it needs in memory, so it can paint
     * immediately and fill in what the server adds a moment later. Callers get a
     * promise that is already resolved; the real work runs behind it, is
     * deduplicated, and is skipped entirely if it ran a few seconds ago.
     */
    getServerOrders() {
        this.koQueueServerOrderRefresh();
        // Resolve now. Nothing in Odoo reads this return value — it is only
        // awaited — and no screen should be held back by it.
        return Promise.resolve([]);
    },

    /**
     * @param {{force?: boolean}} options force: ignore the throttle window.
     * @returns {Promise} resolves when the refresh in flight (if any) is done.
     */
    koQueueServerOrderRefresh({ force = false } = {}) {
        if (this.koServerOrderRefresh) {
            return this.koServerOrderRefresh;
        }
        if (!force && Date.now() - (this.koServerOrderRefreshAt || 0) < REFRESH_INTERVAL) {
            return Promise.resolve([]);
        }
        this.koServerOrderRefresh = (async () => {
            // Let the caller's own `finally` (which resets loadingOrderState)
            // run first, then hold the flag for the duration of the real fetch.
            // Without this, orders arriving from the server land in the pending
            // set and get pushed straight back up again.
            await Promise.resolve();
            const wasLoading = this.loadingOrderState;
            this.loadingOrderState = true;
            try {
                return await super.getServerOrders();
            } catch (error) {
                // Offline or a slow server must never break the screen; the tab
                // simply shows what is already in memory.
                console.warn("KO POS: background order refresh failed", error);
                return [];
            } finally {
                this.loadingOrderState = wasLoading;
                this.koServerOrderRefreshAt = Date.now();
                this.koServerOrderRefresh = null;
            }
        })();
        return this.koServerOrderRefresh;
    },
});
