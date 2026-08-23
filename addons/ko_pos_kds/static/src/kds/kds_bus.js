/** @odoo-module **/

import { registry } from "@web/core/registry";
import { Interaction } from "@web/public/interaction";

class KdsBusBridge extends Interaction {
    static selector = "#kds-bus-bridge";

    async willStart() {
        const bus = this.services.bus_service;
        await bus.addChannel("ko_pos_kds");
        bus.subscribe("ko_pos_kds_update", () => {
            window.dispatchEvent(new CustomEvent("ko:kds-update"));
        });
    }
}

registry.category("public.interactions").add("ko_pos_kds.bus_bridge", KdsBusBridge);
