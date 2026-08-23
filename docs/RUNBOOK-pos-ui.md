# KO POS UI runbook

`ko_pos_ui` is a presentation-only Odoo 19 addon. It makes the restaurant workflow
feel familiar to staff coming from Thai restaurant systems such as Wongnai POS and
FoodStory POS without copying either product's branding or changing Odoo business
logic.

## Design contract

- At `≥900px`, keep the list-first menu on the left and a fixed 380 px current-order
  pane on the right. Below 900 px, keep Odoo's cart/product pane switch and show one
  full-width menu list.
- Categories are one horizontal scroll row with underline tabs; selected state must come
  from `category.isSelected`, not from guessing which Bootstrap class is absent.
- Product rows use a 54×54 image, Thai name, optional existing `public_description`
  English subline, Odoo's current display price, and functional `− qty +` controls.
- The header reads table, seat, and session state from the current Odoo order/session;
  the inline search writes to Odoo's `searchProductWord`. No parallel UI store is allowed.
- Prompt 400/500/600/700 is bundled locally under `static/src/fonts/`; POS tills must not
  depend on Google Fonts or any other network font request.
- The primary teal action is payment; secondary actions must not compete with it. Use
  flat surfaces and hairline borders, with no shadows.
- Thai helper copy must be short and natural for front-of-house staff.
- Never reimplement price, tax, order, table, configurable-product, or payment state in
  this addon.

## Source and packaging

The reviewable files are under `addons/ko_pos_ui/`, but production still deploys only
`addons.tar.gz`. After every UI edit:

1. Validate `ko_pos_ui.xml` with `xmllint --noout`.
2. Replace the `ko_pos_ui/` directory inside a fresh extraction of `addons.tar.gz`.
3. Repack without `.DS_Store` or `__pycache__`.
4. Confirm the local and repo-root tarballs have the same SHA-256.
5. Ensure the production Compose install/update lists both include `ko_pos_ui`.

The tarball replacement must copy the entire `ko_pos_ui/` tree, including `static/src/fonts/`.
After repacking, extract it again and compare the extracted addon recursively with the
reviewable source copy.

## Production verification

1. Confirm `addons-init` lists `ko_pos_ui`.
2. Confirm `odoo-upgrade` installs/updates `ko_pos_ui` without an asset or QWeb error.
3. Confirm `ir.module.module` reports `ko_pos_ui` as `installed`.
4. Open `/pos/ui` in an authenticated browser and verify at tablet and mobile widths:
   - table/floor screen loads;
   - the header shows the real table, seat count, and session number;
   - inline search opens/closes, clears on close, and matches Thai product names plus an
     English `public_description` when one is configured;
   - categories scroll horizontally and only the selected tab has the teal underline;
   - product rows show a 54×54 image/placeholder, name, current price, and options hint;
   - tapping a plain product adds/merges through Odoo; tapping a configurable product
     still opens Odoo's configurator until the dedicated §2 sheet is implemented;
   - both the menu-row and current-order steppers change the existing Odoo orderline;
   - at `≥900px` the order pane is exactly 380 px on the right; below 900 px the View
     order pill switches to Odoo's cart pane;
   - payment button is prominent and navigates correctly, but do not complete a payment
     during UI QA;
   - no browser console error is introduced by `ko_pos_ui`.
5. Confirm the closing dialog says `0 ออเดอร์: 0.00 ฿` before closing a QA session.
   Odoo 19 may immediately create a fresh unnumbered `opening_control` session after
   frontend close; do not loop open/close trying to remove it. See `GOTCHAS.md`.

## §1 implementation status (2026-08-23)

- Implemented in `addons/ko_pos_ui/` and packed into `addons.tar.gz`; not deployed yet.
- XML and JavaScript syntax pass; SCSS compiles standalone; every inherited XPath was
  checked against Odoo 19 source and matches exactly once.
- A simulated `addons-init` extraction + `thai_v2` overlay still leaves the new UI files
  and exactly 57 Thai override `.po` files.
- Authenticated visual and interaction QA is still required. Do not promote this section
  to the production baseline until the deploy log and live POS checks pass.

## Previous UI visual baseline (2026-08-22; superseded after §1 deploy)

- Tablet `1024×768`: no document overflow; order pane ~369 px, menu pane ~655 px,
  four menu cards per row, and the payment button remains fully inside the viewport.
- Mobile `390×844`: no document overflow; two menu cards per row (~176 px each),
  horizontal category scrolling, and the payment/cart bar remains visible at the bottom.
- A first-pass issue where Thai names were squeezed beside the price was fixed by placing
  the full-width name above a right-aligned price.

This is a static layout baseline, not evidence that Odoo assets installed in production.
Repeat the production checklist after every deploy.

## Last production deploy (2026-08-23)

- Snapshot action `110737091` completed before the change.
- Final deploy action `110739168` completed and the project is running: Postgres healthy,
  Odoo up, and both init services exited 0.
- `addons-init` listed `ko_pos_ui`; `odoo-upgrade` logged `Loading module ko_pos_ui
  (88/88)` and `Module ko_pos_ui loaded` with no upgrade error or traceback.
- Thai overrides still reported exactly 57 files.
- Authenticated `/pos/ui` QA passed at `1280×720`: no document overflow, Thai workflow
  headings and menu prices render, the selected category is green with white text, and
  inactive categories remain visually distinct. No product or payment was created.
- Local responsive QA remains the evidence for `1024×768` and `390×844`; the production
  browser surface used for final verification could not be resized.
- QA sessions through `My Company/00011` closed with 0 orders and 0.00. One fresh
  unnumbered `opening_control` session remains by Odoo design after frontend close.

## Rollback

Remove `ko_pos_ui` from both `-i` and `-u` lists in the saved Compose, redeploy, and
clear browser asset caches. This removes the visual layer; it does not alter sales data.
