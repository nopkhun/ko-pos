/** @odoo-module **/

import { Component, reactive, useState } from "@odoo/owl";
import { formatCurrency } from "@web/core/currency";
import { usePos } from "@point_of_sale/app/hooks/pos_hook";
import { showKoToast } from "./ko_toast";

export const koItemOptionsState = reactive({ product: null, orderline: null });

export function openKoItemOptions(product, orderline = null) {
    koItemOptionsState.product = product || orderline?.product_id?.product_tmpl_id || null;
    koItemOptionsState.orderline = orderline;
}

export function closeKoItemOptions() {
    koItemOptionsState.product = null;
    koItemOptionsState.orderline = null;
}

function cleanText(value) {
    return String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function valuesOf(attributeLine) {
    return attributeLine.values?.() || attributeLine.product_template_value_ids || [];
}

export class KoItemOptionsSheet extends Component {
    static template = "ko_pos_ui.ItemOptionsSheet";
    static props = {
        product: { type: [Object, { value: null }], optional: true },
        orderline: { type: [Object, { value: null }], optional: true },
        onClose: { type: Function, optional: true },
    };

    setup() {
        this.pos = usePos();
        const selectedOnLine = new Set(
            (this.props.orderline?.attribute_value_ids || []).map((value) => value.id)
        );
        const customValues = Object.fromEntries(
            (this.props.orderline?.custom_attribute_value_ids || []).map((item) => [
                item.custom_product_template_attribute_value_id?.id,
                item.custom_value || "",
            ])
        );
        const selectedByAttribute = {};

        for (const line of this.attributeLines) {
            const values = valuesOf(line).filter((value) => !value.excluded);
            const existing = values.filter((value) => selectedOnLine.has(value.id));
            selectedByAttribute[line.attribute_id.id] =
                line.attribute_id.display_type === "multi"
                    ? existing.map((value) => value.id)
                    : [existing[0]?.id || values[0]?.id].filter(Boolean);
        }

        this.state = useState({
            selectedByAttribute,
            customValues,
            note: this.props.orderline?.getCustomerNote?.() || "",
            qty: Math.max(1, Math.abs(this.props.orderline?.getQuantity?.() || 1)),
            saving: false,
        });
    }

    get product() {
        return (
            this.props.product ||
            this.props.orderline?.product_id?.product_tmpl_id ||
            this.props.orderline?.getProduct?.()?.product_tmpl_id
        );
    }

    get attributeLines() {
        return (this.product?.attribute_line_ids || []).filter((line) => line.active !== false);
    }

    get isEditing() {
        return Boolean(this.props.orderline);
    }

    get title() {
        return this.product?.display_name || this.product?.name || "เมนู";
    }

    get englishSubline() {
        return cleanText(this.product?.public_description || this.product?.description_sale || "");
    }

    get selectedValues() {
        const ids = new Set(Object.values(this.state.selectedByAttribute).flat());
        return this.attributeLines.flatMap(valuesOf).filter((value) => ids.has(value.id));
    }

    get priceExtra() {
        return this.selectedValues
            .filter((value) => value.attribute_id.create_variant === "no_variant")
            .reduce((sum, value) => sum + (value.price_extra || 0), 0);
    }

    get selectedVariant() {
        const variantIds = this.selectedValues
            .filter((value) => value.attribute_id.create_variant !== "no_variant")
            .map((value) => value.id);
        return this.product?.product_variant_ids?.find((variant) => {
            const ids = variant.product_template_attribute_value_ids.map((value) => value.id);
            return variantIds.length && variantIds.every((id) => ids.includes(id));
        });
    }

    get displayPriceExtra() {
        const dynamicExtra = this.selectedVariant
            ? 0
            : this.selectedValues
                  .filter((value) => value.attribute_id.create_variant !== "no_variant")
                  .reduce((sum, value) => sum + (value.price_extra || 0), 0);
        return this.priceExtra + dynamicExtra;
    }

    get basePrice() {
        const order = this.pos.getOrder();
        return (
            this.product?.getPrice?.(
                order?.pricelist_id,
                1,
                this.displayPriceExtra,
                false,
                this.selectedVariant || false
            ) || 0
        );
    }

    get unitPrice() {
        return this.basePrice;
    }

    get totalPrice() {
        return this.unitPrice * this.state.qty;
    }

    get formattedUnitPrice() {
        return formatCurrency(this.unitPrice, this.pos.currency.id);
    }

    get formattedTotalPrice() {
        return formatCurrency(this.totalPrice, this.pos.currency.id);
    }

    get isValid() {
        const complete = this.attributeLines.every((line) => {
            const selected = this.state.selectedByAttribute[line.attribute_id.id] || [];
            return line.attribute_id.display_type === "multi" || selected.length === 1;
        });
        const customComplete = this.selectedValues
            .filter((value) => value.is_custom)
            .every((value) => String(this.state.customValues[value.id] || "").trim());
        const conflict = this.selectedValues.some((value) =>
            this.pos.doHaveConflictWith(value, this.selectedValues)
        );
        const alwaysIds = this.selectedValues
            .filter((value) => value.attribute_id.create_variant === "always")
            .map((value) => value.id);
        const archived = alwaysIds.length && this.product._isArchivedCombination(alwaysIds);
        return complete && customComplete && !conflict && !archived && !this.state.saving;
    }

    isSelected(attributeLine, value) {
        return (this.state.selectedByAttribute[attributeLine.attribute_id.id] || []).includes(value.id);
    }

    selectValue(attributeLine, value) {
        if (this.pos.doHaveConflictWith(value, this.selectedValues)) {
            return;
        }
        const attributeId = attributeLine.attribute_id.id;
        const current = this.state.selectedByAttribute[attributeId] || [];
        if (attributeLine.attribute_id.display_type === "multi") {
            this.state.selectedByAttribute[attributeId] = current.includes(value.id)
                ? current.filter((id) => id !== value.id)
                : [...current, value.id];
        } else {
            this.state.selectedByAttribute[attributeId] = [value.id];
        }
    }

    formatExtra(value) {
        if (!value.price_extra) {
            return "";
        }
        const sign = value.price_extra < 0 ? "−" : "+";
        return `${sign}${formatCurrency(Math.abs(value.price_extra), this.pos.currency.id)}`;
    }

    setCustomValue(value, event) {
        this.state.customValues[value.id] = event.target.value;
    }

    incrementQty() {
        this.state.qty += 1;
    }

    decrementQty() {
        this.state.qty = Math.max(1, this.state.qty - 1);
    }

    buildPayload() {
        return {
            attribute_value_ids: this.selectedValues.map((value) => value.id),
            attribute_custom_values: Object.fromEntries(
                this.selectedValues
                    .filter((value) => value.is_custom)
                    .map((value) => [value.id, String(this.state.customValues[value.id] || "").trim()])
            ),
            price_extra: this.priceExtra,
            qty: this.state.qty,
        };
    }

    async save() {
        const order = this.pos.getOrder();
        if (!order || !this.isValid) {
            return;
        }
        order.assertEditable();
        this.state.saving = true;
        try {
            const replacement = await this.pos.addLineToCurrentOrder({
                product_tmpl_id: this.product,
                qty: this.state.qty,
                customer_note: (this.state.note || "").trim(),
                payload: this.buildPayload(),
            });
            if (!replacement) {
                return;
            }
            replacement.setCustomerNote((this.state.note || "").trim());
            if (this.isEditing) {
                order.removeOrderline(this.props.orderline);
                showKoToast(`บันทึกตัวเลือกของ ${this.title} แล้ว`);
            } else {
                showKoToast(`เพิ่ม ${this.title} ลงออเดอร์แล้ว`);
            }
            this.close();
        } finally {
            this.state.saving = false;
        }
    }

    remove() {
        if (this.props.orderline) {
            const order = this.pos.getOrder();
            order.assertEditable();
            order.removeOrderline(this.props.orderline);
            showKoToast(`ลบรายการ ${this.title} แล้ว`);
        }
        this.close();
    }

    close() {
        closeKoItemOptions();
        this.props.onClose?.();
    }
}
