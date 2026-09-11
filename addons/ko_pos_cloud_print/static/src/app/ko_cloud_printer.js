/** @odoo-module **/

import { BasePrinter } from "@point_of_sale/app/utils/printer/base_printer";
import { htmlToCanvas } from "@point_of_sale/app/services/render_service";
import { toCanvas } from "@point_of_sale/app/utils/html-to-image";
import { waitImages } from "@point_of_sale/utils";
import { ConnectionLostError, rpc } from "@web/core/network/rpc";
import { _t } from "@web/core/l10n/translation";

export const KO_PRINT_JOB_URL = "/ko_print/job";

/**
 * Core renders the receipt at pixelRatio 1 (hard-coded in `htmlToCanvas`). The
 * receipt element is roughly 300 CSS px wide and an 80 mm head prints 576 dots,
 * so a 1x canvas has to be scaled *up* by the agent — which turns Thai tone
 * marks and vowel signs into mush. Rendering at 2x gives the agent more pixels
 * than it needs and it downsamples instead.
 */
const KO_PIXEL_RATIO = 2;

/**
 * Strip the control characters that break the SVG serialisation html-to-image
 * builds the canvas from. Core's `render_service` does this in its own
 * `sanitizeNodeText`, which it does not export, so it is repeated here.
 */
function koSanitizeNodeText(element) {
    if (element.nodeType === Node.TEXT_NODE) {
        // eslint-disable-next-line no-control-regex
        element.textContent = element.textContent.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
        return;
    }
    for (const child of element.childNodes) {
        koSanitizeNodeText(child);
    }
}

/**
 * Same contract as core's `htmlToCanvas`, with a pixel ratio we choose.
 *
 * It has to clone into `.render-container` exactly the way core does: the
 * element only has its real size and styling once it is in the document.
 */
async function koHtmlToCanvas(el, options = {}) {
    const container = document.querySelector(".render-container");
    if (!container) {
        throw new Error("render-container is not mounted");
    }
    const clone = el.cloneNode(true);
    if (options.addClass) {
        clone.classList.add(...options.addClass.split(" "));
    }
    koSanitizeNodeText(clone);
    container.textContent = "";
    container.appendChild(clone);
    try {
        await waitImages(clone);
        return await toCanvas(clone, {
            backgroundColor: "#ffffff",
            height: Math.ceil(clone.clientHeight),
            width: Math.ceil(clone.clientWidth),
            pixelRatio: KO_PIXEL_RATIO,
            includeQueryParams: true,
        });
    } finally {
        clone.remove();
    }
}

/**
 * A printer that never touches a printer.
 *
 * The POS is served over HTTPS from a VPS; the thermal printer sits on the shop
 * LAN. The browser cannot reach it and Odoo cannot reach it either. So this
 * class renders the receipt to a PNG (exactly as `BasePrinter` already does for
 * the Epson path) and posts it to Odoo as a print job. A Python agent on a PC in
 * the shop polls for those jobs and pushes them out over raw TCP 9100.
 */
export class KoCloudPrinter extends BasePrinter {
    /**
     * @param {number} printer_id  id of the `pos.printer` record (type ko_cloud)
     * @param {boolean} cashdrawer kick the drawer when a receipt prints
     * @param {string} origin      order name, or "kitchen" for a preparation ticket
     * @param {number} [config_id] the POS this job belongs to, for troubleshooting
     * @param {function} [notify]  (message) => void, shown as a toast
     * @param {function} [webPrint] (el) => void, the browser-print fallback
     */
    setup({ printer_id, cashdrawer = false, origin = "", config_id = false,
            notify = null, webPrint = null } = {}) {
        super.setup(...arguments);
        this.printerId = printer_id;
        this.cashdrawer = Boolean(cashdrawer);
        this.origin = origin;
        this.configId = config_id;
        this.notify = notify;
        this.webPrint = webPrint;
        // The element currently being printed, kept so the browser fallback has
        // something to hand to window.print() when the agent is offline.
        this.lastElement = null;
    }

    /**
     * @override
     *
     * Same loop as `BasePrinter.printReceipt`, with two changes: the canvas is
     * rendered at KO_PIXEL_RATIO, and the element is remembered so an offline
     * agent can fall back to browser printing.
     */
    async printReceipt(receipt) {
        if (receipt) {
            this.receiptQueue.push(receipt);
        }
        let printResult;
        while (this.receiptQueue.length > 0) {
            const el = this.receiptQueue.shift();
            this.lastElement = el;
            let canvas;
            try {
                canvas = await koHtmlToCanvas(el, { addClass: "pos-receipt-print" });
            } catch (renderError) {
                if (!document.querySelector(".render-container")) {
                    // Core's htmlToCanvas dereferences that same container
                    // without checking, so falling back would only swap a
                    // readable message for an opaque TypeError.
                    throw renderError;
                }
                // Never lose a receipt over a rendering detail: fall back to the
                // core 1x path, which is known to work everywhere.
                canvas = await htmlToCanvas(el, { addClass: "pos-receipt-print" });
            }
            const image = this.processCanvas(canvas);
            try {
                printResult = await this.sendPrintingJob(image);
            } catch (error) {
                this.receiptQueue.length = 0;
                if (error instanceof ConnectionLostError) {
                    return this.getOfflineError();
                }
                return this.getActionError();
            }
            if (!printResult || printResult.result === false) {
                this.receiptQueue.length = 0;
                return this.getResultsError(printResult);
            }
        }
        return {
            successful: true,
            warningCode: this.getResultWarningCode(printResult),
        };
    }

    /**
     * @override
     * PNG, not JPEG: a receipt is black text on white, so PNG is both smaller
     * and free of the ringing artefacts JPEG puts around Thai glyphs.
     */
    processCanvas(canvas) {
        return canvas.toDataURL("image/png").split(",")[1];
    }

    /**
     * @override
     */
    async sendPrintingJob(img) {
        const result = await rpc(KO_PRINT_JOB_URL, {
            printer_id: this.printerId,
            image_png_b64: img || null,
            cut: true,
            open_cashdrawer: this.cashdrawer,
            origin: this.origin,
            config_id: this.configId,
        });
        if (result && result.ok) {
            return { result: true, jobId: result.job_id };
        }
        return { result: false, reason: result?.reason || "unknown", canRetry: true };
    }

    /**
     * @override
     * A drawer kick is a job with no image.
     */
    async openCashbox() {
        try {
            return await rpc(KO_PRINT_JOB_URL, {
                printer_id: this.printerId,
                image_png_b64: null,
                cut: false,
                open_cashdrawer: true,
                origin: "cashdrawer",
                config_id: this.configId,
            });
        } catch {
            // The drawer is a convenience; never let it break the sale.
            return { ok: false };
        }
    }

    /**
     * Print through the browser so the cashier still walks away with a receipt.
     * Only the customer receipt printer is given a `webPrint` callback — a
     * kitchen ticket printed on the cashier's A4 printer helps nobody.
     */
    _fallbackToWebPrint() {
        if (!this.webPrint || !this.lastElement) {
            return false;
        }
        try {
            this.webPrint(this.lastElement);
            this.notify?.(
                _t("Print agent offline — printing through the browser instead.")
            );
            return true;
        } catch {
            return false;
        }
    }

    /**
     * @override
     * Shaped like `EpsonPrinter.getResultsError` so `PosPrinterService` shows
     * its standard retry/cancel dialog without knowing about this class.
     */
    getResultsError(printResult) {
        const reason = printResult?.reason;
        let body;
        if (reason === "agent_offline") {
            this._fallbackToWebPrint();
            body = _t(
                "The shop print agent is not responding. Check that the PC running it is " +
                "switched on and connected to the shop network, then try again."
            );
        } else if (reason === "no_agent") {
            body = _t("This printer has no print agent assigned. Set one under Point of Sale > Configuration > Printers.");
        } else if (reason === "not_a_cloud_printer" || reason === "no_printer") {
            body = _t("This printer is not configured to use a KO print agent.");
        } else if (reason === "image_too_large") {
            body = _t("The receipt image is too large to send. Please print it through the browser instead.");
        } else if (reason === "printer_not_in_config") {
            body = _t("This printer does not belong to this point of sale.");
        } else if (reason === "no_config") {
            body = _t("This point of sale could not be identified. Please reload the session.");
        } else if (reason === "nothing_to_print") {
            body = _t("There was nothing to send to the printer.");
        } else {
            body = _t("The print job could not be queued. Please try again.");
        }
        return {
            successful: false,
            canRetry: true,
            errorCode: reason,
            message: {
                title: _t("Printing failed"),
                body: body,
            },
        };
    }
}
