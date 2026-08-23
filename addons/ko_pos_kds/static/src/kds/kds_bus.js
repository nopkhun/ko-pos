/** @odoo-module **/

import { registry } from "@web/core/registry";
import { Interaction } from "@web/public/interaction";

/**
 * Each kitchen screen listens on the bus channel of its own POS
 * (`ko_pos_kds_<config_id>`), so an order rung up in another shop never
 * wakes this board. The channel is rendered into the bridge element by
 * `ko_pos_kds.kds_page`.
 */
class KdsBusBridge extends Interaction {
    static selector = "#kds-bus-bridge";

    async willStart() {
        const channel = this.el?.dataset?.channel || "ko_pos_kds_0";
        const bus = this.services.bus_service;
        await bus.addChannel(channel);
        bus.subscribe("ko_pos_kds_update", () => {
            window.dispatchEvent(new CustomEvent("ko:kds-update"));
        });
    }
}

registry.category("public.interactions").add("ko_pos_kds.bus_bridge", KdsBusBridge);
