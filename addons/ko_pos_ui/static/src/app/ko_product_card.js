/** @odoo-module **/

import { ProductCard } from "@point_of_sale/app/components/product_card/product_card";
import { formatCurrency } from "@web/core/currency";
import { patch } from "@web/core/utils/patch";

patch(ProductCard.prototype, {
    /**
     * Use Odoo's own pricelist and tax helpers so the card agrees with the
     * current order. The fallback deliberately fails soft: a malformed product
     * must never prevent the cashier from opening the selling screen.
     */
    get koDisplayPrice() {
        const product = this.props.product;
        const pos = this.env.services.pos;
        try {
            const order = pos.getOrder();
            const pricelist = order?.pricelist_id;
            const fiscalPosition = order?.fiscal_position_id;
            const price = product.getPrice(pricelist, 1);
            const taxDetails = product.getTaxDetails({
                overridedValues: { price, pricelist, fiscalPosition },
            });
            const amount =
                pos.config.iface_tax_included === "total"
                    ? taxDetails.total_included
                    : taxDetails.total_excluded;
            return formatCurrency(amount, pos.currency.id);
        } catch {
            return product?.displayPriceUnit || "";
        }
    },
});
