# KO POS UI runbook

`ko_pos_ui` is a presentation-only Odoo 19 addon. It makes the restaurant workflow
feel familiar to staff coming from Thai restaurant systems such as Wongnai POS and
FoodStory POS without copying either product's branding or changing Odoo business
logic.

## Design contract

- Keep the current order visible on the left and the menu on the right on tablets.
- Categories are a single horizontal, scrollable row with a clearly selected state.
- Category highlighting must account for Odoo 19's separate inactive markers:
  `opacity-75` for root categories and `border-0` for child categories.
- Product cards have large touch targets, name, current display price, and cart quantity.
- The primary green action is payment; secondary actions must not compete with it.
- Thai helper copy must be short and natural for front-of-house staff.
- Mobile keeps a two-column menu grid and Odoo's cart/product pane switch.
- Never reimplement price, tax, order, table, or payment state in this addon.

## Source and packaging

The reviewable files are under `addons/ko_pos_ui/`, but production still deploys only
`addons.tar.gz`. After every UI edit:

1. Validate `ko_pos_ui.xml` with `xmllint --noout`.
2. Replace the `ko_pos_ui/` directory inside a fresh extraction of `addons.tar.gz`.
3. Repack without `.DS_Store` or `__pycache__`.
4. Confirm the local and repo-root tarballs have the same SHA-256.
5. Ensure the production Compose install/update lists both include `ko_pos_ui`.

## Production verification

1. Confirm `addons-init` lists `ko_pos_ui`.
2. Confirm `odoo-upgrade` installs/updates `ko_pos_ui` without an asset or QWeb error.
3. Confirm `ir.module.module` reports `ko_pos_ui` as `installed`.
4. Open `/pos/ui` in an authenticated browser and verify at tablet and mobile widths:
   - table/floor screen loads;
   - current-order and menu headings render in Thai;
   - categories scroll horizontally and the selected category is obvious;
   - product cards show a price and cart quantity;
   - tapping a product adds it once and updates the visible cart;
   - payment button is prominent, but do not complete a payment during UI QA;
   - no browser console error is introduced by `ko_pos_ui`.
5. Remove any empty test order/session without closing a session that contains real sales.

## Last local visual baseline (2026-08-22)

- Tablet `1024×768`: no document overflow; order pane ~369 px, menu pane ~655 px,
  four menu cards per row, and the payment button remains fully inside the viewport.
- Mobile `390×844`: no document overflow; two menu cards per row (~176 px each),
  horizontal category scrolling, and the payment/cart bar remains visible at the bottom.
- A first-pass issue where Thai names were squeezed beside the price was fixed by placing
  the full-width name above a right-aligned price.

This is a static layout baseline, not evidence that Odoo assets installed in production.
Repeat the production checklist after every deploy.

## Rollback

Remove `ko_pos_ui` from both `-i` and `-u` lists in the saved Compose, redeploy, and
clear browser asset caches. This removes the visual layer; it does not alter sales data.
