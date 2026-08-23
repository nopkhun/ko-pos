/** @odoo-module **/

import { Component, reactive, useState, xml } from "@odoo/owl";
import { registry } from "@web/core/registry";

/**
 * KO KDS — kitchen → front of house alert.
 *
 * When a station reports that a dish is out of stock, late, or needs to be
 * swapped, front of house has to *notice*. A toast that fades after two
 * seconds is not enough on a busy counter, so this renders a red bar that
 * stays until someone presses รับทราบ, backed by a repeating chime.
 */
export const koKitchenAlertState = reactive({
    items: [],
    muted: false,
});

let audioCtx = null;
let repeatTimer = null;
// Kept outside the reactive object: a callback has no business being proxied.
let ackHandler = null;

export function setKitchenAlertAckHandler(handler) {
    ackHandler = handler;
}

function chime(times = 3) {
    try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === "suspended") {
            audioCtx.resume();
        }
        for (let i = 0; i < times; i++) {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            const start = audioCtx.currentTime + i * 0.32;
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.type = "square";
            // Lower and harsher than the KDS "new order" beep so staff can tell
            // an incoming order from a problem without looking.
            osc.frequency.value = 520;
            gain.gain.setValueAtTime(0.28, start);
            gain.gain.exponentialRampToValueAtTime(0.001, start + 0.28);
            osc.start(start);
            osc.stop(start + 0.3);
        }
    } catch (e) {
        /* autoplay policy — the red bar still shows */
    }
}

function stopRepeat() {
    if (repeatTimer) {
        clearInterval(repeatTimer);
        repeatTimer = null;
    }
}

function startRepeat() {
    if (repeatTimer) {
        return;
    }
    repeatTimer = setInterval(() => {
        if (!koKitchenAlertState.items.length) {
            stopRepeat();
            return;
        }
        if (!koKitchenAlertState.muted) {
            chime(1);
        }
    }, 20000);
}

/**
 * Replace the list of open kitchen alerts.
 * @param {Array} items alerts currently unacknowledged
 * @returns {Array} the alerts that are new since the previous call
 */
export function setKitchenAlerts(items) {
    const previous = new Set(koKitchenAlertState.items.map((item) => item.key));
    const fresh = items.filter((item) => !previous.has(item.key));
    koKitchenAlertState.items = items;
    if (fresh.length) {
        koKitchenAlertState.muted = false;
        chime(3);
    }
    if (items.length) {
        startRepeat();
    } else {
        stopRepeat();
    }
    return fresh;
}

export class KoKitchenAlert extends Component {
    static props = {};
    static template = xml`
        <div t-if="state.items.length" class="ko-kds-alert" role="alert">
            <div class="ko-kds-alert-icon">⚠</div>
            <div class="ko-kds-alert-body">
                <div class="ko-kds-alert-title">
                    ครัวแจ้งปัญหา <t t-esc="state.items.length"/> รายการ
                </div>
                <t t-foreach="state.items" t-as="item" t-key="item.key">
                    <div class="ko-kds-alert-line">
                        <b t-esc="item.label"/>
                        <span> · </span>
                        <t t-esc="item.dish"/>
                        <span class="ko-kds-alert-where"> · <t t-esc="item.orderLabel"/></span>
                        <span t-if="item.note" class="ko-kds-alert-note"> — <t t-esc="item.note"/></span>
                    </div>
                </t>
            </div>
            <button class="ko-kds-alert-ack" t-on-click="() => this.acknowledge()">
                รับทราบ
            </button>
        </div>
    `;

    setup() {
        this.state = useState(koKitchenAlertState);
    }

    acknowledge() {
        if (ackHandler) {
            ackHandler(this.state.items.slice());
        }
        koKitchenAlertState.items = [];
        koKitchenAlertState.muted = true;
        stopRepeat();
    }
}

registry.category("main_components").add("ko_pos_kds.KitchenAlert", { Component: KoKitchenAlert });
