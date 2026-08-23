/** @odoo-module **/

import { ProductCard } from "@point_of_sale/app/components/product_card/product_card";
import { ProductTemplate } from "@point_of_sale/app/models/product_template";
import { formatCurrency } from "@web/core/currency";
import { normalize } from "@web/core/l10n/utils";
import { patch } from "@web/core/utils/patch";

function plainText(value) {
    return String(value || "")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

patch(ProductTemplate.prototype, {
    /**
     * public_description is the existing Odoo field used for the English
     * menu subline. Including it here lets the standard POS search match
     * both the Thai product name and that English subline.
     */
    get searchString() {
        const description = normalize(plainText(this.public_description));
        return description ? `${super.searchString} ${description}` : super.searchString;
    },
});

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

    get koEnglishName() {
        return plainText(this.props.product?.public_description);
    },

    get koHasOptions() {
        const product = this.props.product;
        return Boolean(
            product?.needToConfigure?.() ||
                product?.isConfigurable?.() ||
                product?.isCombo?.() ||
                product?.pos_optional_product_ids?.length
        );
    },

    get koHasCartQuantity() {
        return Number(this.props.productCartQty || 0) > 0;
    },

    koIncrement(event) {
        event.stopPropagation();
        return this.props.onClick(event);
    },

    koDecrement(event) {
        event.stopPropagation();
        const order = this.env.services.pos.getOrder();
        const productTemplateId = this.props.product?.id;
        const matchingLines = (order?.lines || []).filter(
            (line) =>
                !line.combo_parent_id &&
                line.product_id?.product_tmpl_id?.id === productTemplateId &&
                line.getQuantity() > 0
        );
        const line = matchingLines.at(-1);
        if (!line) {
            return;
        }

        order.assertEditable();
        const nextQuantity = line.getQuantity() - 1;
        if (nextQuantity <= 0) {
            order.removeOrderline(line);
        } else {
            line.setQuantity(nextQuantity, Boolean(line.combo_line_ids?.length));
        }
    },
});
