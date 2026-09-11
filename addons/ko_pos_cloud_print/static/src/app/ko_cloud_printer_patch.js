/** @odoo-module **/

import { patch } from "@web/core/utils/patch";
import { PosStore } from "@point_of_sale/app/services/pos_store";
import { HardwareProxy } from "@point_of_sale/app/services/hardware_proxy_service";
import { KoCloudPrinter } from "./ko_cloud_printer";

/**
 * KO cloud print — POS side.
 *
 * Three hooks, no new print paths:
 *
 * 1. `createPrinter` returns a KoCloudPrinter for any `pos.printer` of type
 *    `ko_cloud`. That single line is what makes **kitchen tickets** work: core
 *    builds `unwatched.printers` from `createPrinter` in `processServerData`,
 *    and `printChanges` (the pos_restaurant "order changes" path) calls
 *    `printer.printReceipt(...)` on each of them. Nothing else is needed.
 *
 * 2. `afterProcessServerData` points `hardwareProxy.printer` at the configured
 *    KO **receipt** printer, the same place core points it at an EpsonPrinter.
 *    `PosPrinterService` reads `hardware_proxy.printer` on every print, so the
 *    customer receipt then goes out silently too.
 *
 * 3. `HardwareProxy.openCashbox` is patched so the drawer button actually
 *    works. Core gates it on an IoT box reporting "connected" or an Epson IP
 *    being set; with a cloud printer neither is ever true, so every manual
 *    drawer kick — the payment screen, the session-closing popup, cash in/out —
 *    would silently do nothing.
 *
 * 4. The receipt printer has to be *loaded* as a `pos.printer` record for
 *    `config.ko_receipt_printer_id` to resolve at all (the POS relational layer
 *    silently drops a many2one whose target was not loaded). Loading it makes
 *    core treat it as a preparation printer as well, so it is taken back out of
 *    `unwatched.printers` unless it really is one.
 */
patch(PosStore.prototype, {
    /** id of the configured KO receipt printer, or false. */
    get koReceiptPrinterId() {
        const value = this.config?.ko_receipt_printer_id;
        if (!value) {
            return false;
        }
        return typeof value === "object" ? value.id : value;
    },

    koCreateCloudPrinter(printerConfig, { cashdrawer = false, origin = "" } = {}) {
        return new KoCloudPrinter({
            printer_id: printerConfig.id,
            cashdrawer,
            origin,
            config_id: this.config?.id,
            notify: (message) => this.notification?.add(message, { type: "warning" }),
            // Only the receipt printer gets a browser fallback; see
            // KoCloudPrinter._fallbackToWebPrint.
            webPrint: origin === "receipt" ? (el) => this.printer.printWeb(el) : null,
        });
    },

    /**
     * @override
     * Kitchen tickets and every other preparation printer come through here.
     */
    createPrinter(config) {
        if (config.printer_type === "ko_cloud") {
            return this.koCreateCloudPrinter(config, { origin: "kitchen" });
        }
        return super.createPrinter(...arguments);
    },

    /**
     * @override
     * Core has just filled `unwatched.printers` from every loaded pos.printer.
     * The receipt printer is loaded only so the many2one resolves; it is not a
     * preparation printer unless the shop also listed it under printer_ids.
     */
    async processServerData() {
        await super.processServerData(...arguments);
        const receiptPrinterId = this.koReceiptPrinterId;
        if (!receiptPrinterId || !this.unwatched?.printers) {
            return;
        }
        const preparationIds = new Set(
            (this.config.printer_ids || []).map((p) => (typeof p === "object" ? p.id : p))
        );
        if (preparationIds.has(receiptPrinterId)) {
            return;
        }
        this.unwatched.printers = this.unwatched.printers.filter(
            (printer) => printer.config?.id !== receiptPrinterId
        );
        this.config.iface_printers = !!this.unwatched.printers.length;
    },

    /**
     * @override
     */
    async afterProcessServerData() {
        await super.afterProcessServerData(...arguments);
        const receiptPrinterId = this.koReceiptPrinterId;
        if (!receiptPrinterId) {
            return;
        }
        const printerConfig = this.models["pos.printer"].get(receiptPrinterId)?.raw;
        if (!printerConfig || printerConfig.printer_type !== "ko_cloud") {
            return;
        }
        const printer = this.koCreateCloudPrinter(printerConfig, {
            cashdrawer: Boolean(this.config.ko_cashdrawer),
            origin: "receipt",
        });
        printer.config = printerConfig;
        this.hardwareProxy.printer = printer;
    },
});

/**
 * Every manual drawer kick in the POS goes through here — `PosStore.openCashbox`
 * (cash in/out), the payment screen, and the session-closing popup all call it.
 * Core refuses unless an IoT box is connected or an Epson IP is configured, so
 * a cloud printer needs its own branch or the drawer never opens.
 */
patch(HardwareProxy.prototype, {
    async openCashbox(action = false) {
        const printer = this.printer;
        if (printer instanceof KoCloudPrinter) {
            if (!this.pos?.config?.ko_cashdrawer) {
                return;
            }
            await printer.openCashbox();
            if (action) {
                this.pos.logEmployeeMessage(action, "CASH_DRAWER_ACTION");
            }
            return;
        }
        return super.openCashbox(...arguments);
    },
});
