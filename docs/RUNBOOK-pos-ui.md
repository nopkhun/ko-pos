# KO POS UI runbook

`ko_pos_ui` is a presentation-only Odoo 19 addon. It makes the restaurant workflow
feel familiar to staff coming from Thai restaurant systems such as Wongnai POS and
FoodStory POS without copying either product's branding or changing Odoo business
logic.

## Design contract

- At `≥900px`, keep the list-first menu on the left and a fixed 380 px current-order
  pane on the right. Below 900 px, keep Odoo's cart/product pane switch and show one
  full-width menu list.
- Categories are one horizontal scroll row with underline tabs; selected state must
  compare `pos.selectedCategory.id` with the current category id so ancestor categories
  do not appear selected.
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

- Deployed from commit `75ae107`; final Hostinger action `110810391` succeeded.
- XML and JavaScript syntax pass, SCSS compiles standalone, tarball/source parity passes,
  and the simulated init pipeline still produces exactly 57 Thai override `.po` files.
- Authenticated production QA passed at `1280×800` and `390×844`: Thai search,
  category filtering, a plain-product add/merge, menu and current-order steppers, payment
  navigation without validation, and the mobile View order/cart switch all work.
- Header context reads `ขายหน้าเคาน์เตอร์`, one seat, and live session `#0020`.
  Mobile document width equals the 390 px viewport and console logs are clean.
- The live seed menu has no configurable product and no English `public_description`;
  those two data-dependent checks wait for real menu data. One unsent/unpaid QA draft
  line remains pending explicit deletion confirmation.

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

- Final deploy action `110810391` completed and the project is running: Postgres is
  healthy, Odoo is up, and `addons-init` / `odoo-upgrade` both exited 0.
- `odoo-upgrade` logged `Loading module ko_pos_ui (82/88)`, `Module ko_pos_ui loaded`,
  and the Thai override success signal from exactly 57 files. Both Odoo processes list
  `/mnt/extra-addons`; the running service logged `MASTER_PW_LINES=1` and HTTP on 8069.
- No build-log `variable is not set`, invalid-module, manifest, permission, traceback,
  or browser console error remained after the final deploy.
- Live checks passed at `1280×800` and `390×844`; the phone page has no horizontal or
  vertical document overflow. Payment navigation reached the payment screen but no
  payment method was selected and no payment was completed.
- Session `#0020` remains open for normal service. The QA line is draft-only and was
  never sent to the kitchen; remove it after the required browser deletion confirmation,
  and do not close the session.

## Rollback

Remove `ko_pos_ui` from both `-i` and `-u` lists in the saved Compose, redeploy, and
clear browser asset caches. This removes the visual layer; it does not alter sales data.
