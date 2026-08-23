/** @odoo-module **/

import { Component, reactive, useState, xml } from "@odoo/owl";
import { registry } from "@web/core/registry";

export const koToastState = reactive({
    message: null,
});

let toastTimer = null;

export function showKoToast(message, duration = 2600) {
    if (toastTimer) {
        clearTimeout(toastTimer);
    }
    koToastState.message = message;
    toastTimer = setTimeout(() => {
        koToastState.message = null;
        toastTimer = null;
    }, duration);
}

export class KoToast extends Component {
    static props = {};
    static template = xml`
        <div t-if="state.message" class="ko-toast-wrapper" role="status" aria-live="polite">
            <div class="ko-toast-pill" t-esc="state.message"/>
        </div>
    `;

    setup() {
        this.state = useState(koToastState);
    }
}

registry.category("main_components").add("ko_pos_ui.Toast", { Component: KoToast });
