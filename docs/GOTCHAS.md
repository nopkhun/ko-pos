# Gotchas

Every one of these was hit for real on this project. Each entry leads with the
**symptom**, because that is what you will see first.

If you lose time to something new, add it here before you close out — see `../AGENTS.md` §0.

---

### Docker Compose silently ate my shell variable

**Symptom:** A loop or conditional in a Compose `command:` block does nothing. No error.
The log shows the surrounding lines but not the ones inside the loop.

**Cause:** Compose interpolates `$VAR` before the container ever runs and substitutes an
empty string. `for m in account payment; do cat …/$m.append.po; done` becomes
`cat …/.append.po`, matches nothing, exits cleanly.

**Tell:** the build log contains `The "m" variable is not set. Defaulting to a blank string.`

**Fix:** double every dollar sign that belongs to the shell: `$$m`, `$$(cmd)`, `$$@`.
The existing file already does this for `$$@` and `$$(grep -c …)` — follow that pattern.

---

### Deploy wiped the environment variables

**Symptom:** After a deploy, Odoo cannot authenticate to Postgres; looks like a DB fault.

**Cause:** `VPS_createNewProjectV1` *replaces* the project. Calling it without the
`environment` parameter replaces the env with nothing.

**Fix:** always pass `environment` with `DB_PASSWORD` and `TRAEFIK_HOST`. Every time.

---

### Every custom addon becomes “manifest not found” after an image refresh

**Symptom:** `addons-init` lists all custom addon directories, but `odoo-upgrade` says
`invalid module names, ignored: ko_pos_ui`, then reports every existing KO module as
`manifest not found` / `not installable`.

**Cause:** the `odoo:19` image pulled on 2026-08-22 logged an addon namespace that did
not include the mounted `/mnt/extra-addons` directory. Relying on an image default made
the deployment non-reproducible.

**Fix:** pass the full `--addons-path` explicitly on both the long-running `odoo` command
and the one-shot `odoo-upgrade` command, ending with `/mnt/extra-addons`. Verify the first
startup lines of both services include that path.

If this immediately fails with `PermissionError: [Errno 13] Permission denied:
'/mnt/extra-addons'`, make `addons-init` finish with `chmod -R a+rX /mnt/extra-addons`.
The init container writes as root; Odoo runs as a non-root user.

---

### Hostinger action says success while Compose actually failed

**Symptom:** `VPS_getActionDetailsV1` returns `state: success`, but the project is not
running or the build log says `Project deployment failed`.

**Cause:** the Hostinger action tracks acceptance/completion of the API operation, not
the exit status of every gated Compose service. On 2026-08-22 it returned success even
though `odoo-upgrade` exited 1.

**Fix:** treat action success only as permission to inspect the result. Always read the
build log, require `Project deployed successfully`, confirm both init services exited 0,
and inspect the `odoo-upgrade` log before calling a deploy healthy.

---

### The site looks down from the sandbox

**Symptom:** `curl https://kodoo.viakuma.com` from the agent container returns 403 or hangs.

**Cause:** the sandbox has an egress allowlist that does not include this domain. It is a
sandbox restriction, not an outage.

**Fix:** verify through browser tooling or WebFetch. Do not report an outage based on a
sandbox fetch, and do not try to route around the block with other HTTP clients.

---

### I fixed the addon but nothing changed

**Symptom:** Code edited in `addons/`, pushed, deployed — no effect.

**Cause:** Deployment ignores `addons/`. The working Compose clones `main` and unpacks
only the repo-root `addons.tar.gz`.

**Fix:** edit the reviewable source, repack `addons.tar.gz`, commit both, and verify the
remote `main` tree before calling the Hostinger deploy API.

---

### Hostinger rejects the deploy before changing anything because Compose is too large

**Symptom:** `VPS_createNewProjectV1` returns `The content field must not be greater than
8192 characters`; no action ID is created and the existing project remains unchanged.

**Cause:** `vps-compose-simplified.yaml` embeds the whole addon tar as base64 and is about
690 KB. Even valid YAML cannot pass Hostinger's API field limit.

**Fix:** use `deploy_real/vps-compose-git.yaml` from `deploy-secrets.zip`. It stays below
the limit, clones remote `main` with the read-only deploy key, unpacks `addons.tar.gz`,
and contains no obsolete patch pipeline.

---

### KDS clock works, but SLA stays on “กำลังโหลด” and new tabs raise `kdsSetTab is not defined`

**Symptom:** A newly deployed KDS page polls `/kds/data` and the clock updates, but the
new SLA label and tabs do not work. Clicking a tab opens an Odoo client error naming the
missing global function.

**Cause:** `kds.js` is loaded directly rather than through a fingerprinted Odoo asset
bundle. A browser can reuse the older script at the same URL after an addon upgrade.

**Fix:** append the addon version to the direct script URL and bump it whenever that
runtime changes (currently `kds.js?v=19.0.4.0.2`). Verify with a fresh tab that SLA loads
and active/served/cancelled plus order/menu controls work.

If an Odoo banner saying `หน้านี้เลิกใช้งานแล้ว` returns on every fresh KDS page,
do not treat it as ordinary post-deploy cache. The standalone KDS template loads
`web.assets_frontend`, whose asset watchdog compares `bundle_changed.server_version`
with `session.server_version`. Without the `odoo.__session_info__` initialization that
Odoo's standard `web.frontend_layout` performs, the local value is empty and every bus
event looks stale. Seed `request.env['ir.http'].get_frontend_session_info()` before the
asset call; KDS 19.0.4.0.2 includes this fix. Preserve the bus and polling fallback.

After deploying, open a fresh authenticated `/kds`, wait at least 60 seconds for the
watchdog's randomized delay, and confirm the banner does not return while SLA and ticket
data continue updating. If a tab still raises `kdsSetTab is not defined`, close that tab
and open `/kds` again so the versioned runtime is requested.

Verified in production on 2026-08-23 with deploy action `110891014`: the versioned
runtime loaded, polling and read-only controls remained healthy, and the warning did not
return after more than 70 seconds.

---

### Every nested POS category turns green

**Symptom:** Child categories that are not selected look identical to the active category.

**Cause:** Odoo 19 marks an unselected root category with `opacity-75`, but an unselected
child category uses `border-0` instead. Styling every `.category-button:not(.opacity-75)`
therefore catches inactive child categories too.

**Fix:** require both markers to be absent when styling the active path:
`.category-button:not(.opacity-75):not(.border-0)`. Recheck this selector against the
upstream `CategorySelector` template after an Odoo upgrade.

---

### The translation won't apply no matter what I write in the .po

**Symptom:** A `.po` entry looks perfect, deploy is clean, the wording does not change.

**Cause:** the string is a *record name*, not a translatable label. Payment methods, POS
categories, floors, products and journals created by a wizard or a human are rows in the
database. Translation machinery never touches them.

**Tell:** `ir.model.data` has no XML ID for the record.

**Fix:** rename the record in the Odoo UI.

---

### Odoo refuses to save a payment method

**Symptom:** `การดำเนินการไม่ถูกต้อง — กรุณาปิดและยืนยันรอบขายที่เปิดอยู่ก่อนแก้ไขวิธีชำระเงินนี้`

**Cause:** Odoo locks payment-method edits while a POS session is open.

**Fix:** wait until the restaurant closes the session. **Do not close a session with real
sales yourself** — that posts accounting entries and is a business decision.

Also note: after a refused save the form stays dirty. Reload the page to discard cleanly
rather than leaving half-entered data in the UI.

---

### There is no way to cancel or delete a POS session

**Symptom:** A session sits in `opening_control` ("เช็คเงินก่อนเปิดรอบ") with 0 orders,
blocking payment-method edits, and you cannot find a way to get rid of it.

**Cause:** Odoo 19 deliberately exposes no cancel or delete for `pos.session` — it guards
the accounting trail. Checked and confirmed empty in all three places:
the session form's cog menu (only "รายละเอียดการขาย"), the dashboard card's ⋮ menu
(only views, reports, settings), and the list view's Action menu (only "ส่งออก").

The guard on `pos.payment.method.write()` reads `open_session_ids`, which counts **any**
session whose state is not `closed` — including one that was never actually opened.
Check it directly rather than guessing:

```js
model: "pos.payment.method", method: "read",
args: [[5], ["name", "open_session_ids"]]
```

For an empty session (0 orders, 0.00 opening cash), opening and closing is financially
harmless: the close dialog shows all zeros and no revenue is posted. It does consume a
session number, so a `My Company/000NN` with zeros appears in the session list.

Path: Dashboard → **เปิดรอบ** → POS loads → dismiss the order-type dialog **without
creating an order** → ☰ menu → **ปิดรอบ** → confirm the zeros → **ปิดรอบ**.

**New Odoo 19 trap (verified 2026-08-23):** frontend close calls
`pos.config.close_ui()`, whose implementation returns `open_ui()`. After the numbered
session closes, `/pos/ui/<config>/login` creates a fresh unnumbered `opening_control`
session. Repeating the path above therefore creates more zero-valued session numbers but
still leaves one new opening row. Do not loop trying to reach zero open sessions.

For ordinary service this row is safe to leave for the next staff opening, but it still
blocks payment-method configuration. If a maintenance task genuinely requires no open
session, stop and agree a maintenance procedure with the owner; do not invent a direct
state write or delete the row through the ORM.

The UI omission is intentional, and a human should decide anything that touches session
records.

---

### A record reads the same in Thai and English

**Symptom:** You rename something to Thai and `en_US` shows the Thai text too.

**Cause:** it is not translated — it is a plain stored value. Record names created at
runtime (payment methods, products, floors) have one value, not one per language.

**Fix:** nothing to fix; this is correct. Only add a `.po` entry when the string is a
label Odoo ships in English. See `RUNBOOK-translations.md` Step 0.

---

### Base64 chunks arrive corrupted

**Symptom:** Reassembled tarball fails `tar xz` with a CRC error, or blob SHAs don't match.

**Cause:** copying large base64 blocks through a chat context is lossy. At 28 KB per
piece, half the pieces were corrupted; single-character substitutions and truncations.

**Fix:** ~3.6 KB pieces, SHA-verify every one, split failures down to ~900 B, and always
`cat` the file fresh immediately before pushing. Never copy from earlier in the
conversation. Details in `RUNBOOK-translations.md`.

---

### A blob SHA mismatch that isn't actually a problem

**Symptom:** One piece consistently mismatches even after clean re-pushes.

**Cause:** a trailing-newline difference. Base64 decoders ignore newlines entirely.

**Fix:** confirm with `git hash-object` on the content minus the trailing newline. If
that matches, it is harmless — leave it alone rather than burning attempts on it.

---

### `--i18n-overwrite` undid our translations

**Symptom:** Custom Thai wording reverts to stock Odoo Thai after an update.

**Cause:** the flag lets Odoo's own `.po` files overwrite ours. Our hook already runs
last and handles overwriting deliberately.

**Fix:** never pass `--i18n-overwrite` on the update command.

---

### Odoo "crashed" after the upgrade container ran

**Symptom:** `odoo-upgrade` logs `Initiating shutdown` and exits.

**Cause:** it runs with `--stop-after-init`. Exiting is the success path — the next
service is gated on `service_completed_successfully`.

**Fix:** nothing. Read `odoo-1`, not `odoo-upgrade-1`, for the running server.

---

### Cannot change Price Tax computation method on res.company

**Symptom:** `odoo.tools.convert.ParseError: Cannot change Price Tax computation method on a company that has already started invoicing.`

**Cause:** Writing `'account_price_include': 'tax_included'` to `res.company` in a database where invoices or POS orders already exist raises a ValidationError from Odoo's `account` module.

**Fix:** Do not write `account_price_include` programmatically if invoices/sales already exist; update only `name`, `street`, `street2`, `city`, `zip`, `vat`, `country_id`, `state_id`.

---

### Hostinger API Compose content length and YAML validation

**Symptom:** `VPS_createNewProjectV1` returns `The content field must not be greater than 8192 characters.` or `[VPS:2004] File content must be valid YAML`.

**Cause:** The Hostinger VPS API caps the Compose YAML string at 8,192 characters. Additionally, in YAML block scalars (`command: - |`), any line indented less than 8 spaces breaks the scalar and fails the YAML parser.

**Fix:** Keep inline base64 tarballs compact (e.g. gzip stripped of extraneous files) and ensure every line inside `command: - |` has uniform 8-space indentation.

---

### POS addon installs locally but Odoo cannot locate a CategorySelector XPath

**Symptom:** `ko_pos_ui.xml` is well-formed, but the addon upgrade fails because an
inheritance XPath targeting the category list cannot be found.

**Cause:** In Odoo 19, `point_of_sale.CategorySelector` puts `category-list` in
`t-attf-class`, not a literal `class` attribute. `hasclass('category-list')` therefore
does not reliably target that container during template inheritance.

**Fix:** target the source attribute explicitly:
`//div[contains(@t-attf-class, 'category-list')]`. Validate every inherited XPath against
the exact Odoo 19 XML source before packaging; well-formed XML alone does not test this.

---

### The POS loads a blank page although the addon upgrade succeeded

**Symptom:** `ko_pos_ui` installs cleanly, but opening Sell destroys the Owl root and the
console says the XPath for `switchpane/pay-button` cannot be located.

**Cause:** `pos_restaurant` inherits `point_of_sale.ProductScreen` first and replaces the
direct payment button with a `<t>` wrapper. The replacement still contains a payment
button, but it is no longer a direct child of `switchpane`. A direct-child XPath passes
against the base Point of Sale template and still fails in the real restaurant asset.

**Fix:** validate ProductScreen inheritance after installed dependencies, not only against
the base template. Target the nested controls with
`//div[hasclass('switchpane')]//button[...]`.

---

### Category names disappear but the “ทั้งหมด” tab remains

**Symptom:** the category strip contains several blank clickable tabs after the custom
CSS loads.

**Cause:** when a category has no image, Odoo's first child `<div>` is the text wrapper.
Hiding `.category-button > div:first-child` therefore hides the category name too.

**Fix:** hide only the image wrapper (`> div.ratio`) and the image itself. Leave the
`.line-clamp-3` text wrapper visible.

---

### The Sell header ends at `รอบขาย #` with no number

**Symptom:** the active session exists, but its number is blank in the custom header.

**Cause:** a live, not-yet-numbered session name can end with `/`. Splitting on `/` and
returning the last segment returns an empty string before the session is closed.

**Fix:** use the suffix only when non-empty; otherwise fall back to the live session ID
and pad it for display (for example `#0020`).

## Symptom: repo contents and production differ even though the repo looks complete

Before 2026-08-23 there were THREE delivery paths into `/mnt/extra-addons`:
`addons.tar.gz`, `patch/thai_v2` + `patch/thai_v3`, **and a base64 tarball embedded
inline in the Compose file itself** (a `echo "H4sIA..." | base64 -d | tar xz` line).
Diffing the repo's tarball against production showed differences that no repo file
explained, because the third path lived only in `deploy-secrets.zip`. Fixed by folding
all three into `addons.tar.gz`. Lesson: grep the deploy Compose for embedded base64
before concluding the repo is the source of truth.

---

### POS opens with `use_pricelist` / `currency_id` undefined after adding one config field

**Symptom:** the addon upgrades successfully, but POS startup fails with an Owl error or
`KeyError: use_pricelist` and most `pos.config` values are missing.

**Cause:** Odoo 19 deliberately returns an empty field list for `pos.config`, meaning
“read every field.” Overriding `_load_pos_data_fields()` with only the custom field turns
that into “read only this field” and removes the core configuration from the POS payload.

**Fix:** do not override `pos.config._load_pos_data_fields()` for an ordinary stored
field; Odoo's empty-list read already includes it. This exception does not apply to
models such as `pos.category`, whose base method returns an explicit list.

---

### `/kds` returns 500 with “Cannot convert non-stored field to SQL”

**Symptom:** the KDS controller fails while searching `pos.config.current_session_id`.

**Cause:** `current_session_id` is a non-stored computed field in Odoo 19 and cannot be
used in a database domain.

**Fix:** search active `pos.session` records by state and read their `config_id`; fall
back to the first POS config only when no active session exists.

---

### Configurable-product click blanks the POS only in debug assets

**Symptom:** Sell loads, but opening the item-options sheet destroys the Owl root. The
debug console reports invalid props because `orderline` is `null`.

**Cause:** Owl `optional: true` permits an omitted prop, not a prop explicitly passed as
`null`. The parent template always passes both `product` and `orderline` expressions.

**Fix:** allow `{ value: null }` in both prop validators. Also wrap any exported
`reactive()` singleton with the consuming component's `useState()`; mutating a global
proxy alone does not subscribe that component to rerenders.

---

### Payment or receipt still shows stock mobile controls after a “successful” redesign

**Symptom:** desktop looks custom, while phone payment keeps Odoo's stock methods/keypad,
or the receipt shows both stock and custom success/actions.

**Cause:** Odoo 19's mobile `PaymentScreen` branch has no `.main-content`, and replacing
only `.pos-receipt-container` leaves all surrounding stock receipt controls intact.

**Fix:** replace the full `payment-screen`, `receipt-screen`, and (for the custom bills
workflow) `ticket-screen` roots. Validate both `ui.isSmall` branches in a real browser;
well-formed XML and a clean module upgrade do not prove that the intended runtime branch
was replaced.

---

### The kitchen display shows orders from another shop

**Symptom:** with more than one POS (`pos.config`), `/kds` mixes every shop's tickets on
one board; a cook at ร้านหวานอยู่ sees ร้านชอบแกง's orders.

**Cause:** `/kds/data` searched `ko.kds.ticket` with no `config_id` filter at all, and the
bus channel was the single global string `ko_pos_kds`. Tickets already carried
`config_id` from the POS payload — nothing ever read it.

**Fix (`ko_pos_kds` 19.0.5.0.0):** a screen is bound to exactly one POS.
`/kds` is a shop picker (it redirects straight through when the user can see only one
POS), the board lives at `/kds/pos/<config_id>`, and `/kds/data` **requires** `config_id`
and answers `400 config_required` without one — an unscoped request must never fall back
to "everything". Bus channels are `ko_pos_kds_<config_id>`. Tickets and lines carry
`company_id` (stored related from the POS) with global `ir.rule`s, so a second company is
isolated as well. Every mutating `/kds/*` route re-checks that the ticket's POS is one the
user may see.

**If you add another KDS query, scope it.** The default in this module is *not* safe:
`ko.kds.ticket` has no implicit POS filter, so a new search without `('config_id','=',…)`
reintroduces exactly this bug.

---

### A change is pushed and deployed, but production still runs the old code

**Symptom:** the deploy action succeeds, containers are healthy, yet the fix is not there.

**Cause:** until 2026-08-23 `addons-init` preferred `/tmp/repo/addons.tar.gz` over
`/tmp/repo/addons/`. The tarball is binary, so an agent session (which can only push text
through the GitHub MCP) could update `addons/` and leave the tarball stale — and the
tarball is what got deployed.

**Fix:** `addons-init` now copies `/tmp/repo/addons/.` and **exits 1** if that directory
is missing; it never reads the tarball. It also echoes the deployed manifest versions:

```
DEPLOYED_ko_pos_kds:
'version': '19.0.5.0.0',
```

Read that line after every deploy. It is the only cheap proof that the clone carried your
commit.

---

### `rm` and `tar x` fail with "Operation not permitted" in the owner's mounted folder

**Symptom:** working on `KO-DOO` through the desktop bridge, `rm -rf addons` and
`tar xzf … -C addons` both fail on every file; the tree looks corrupted mid-command.

**Cause:** the mounted folder is writable but deletion is blocked, and GNU `tar` unlinks a
file before extracting over it.

**Fix:** extract into a scratch dir outside the mount (`/tmp/...`) and `cp -R /tmp/x/. dest/`
— `cp` truncates in place and needs no unlink. Same trick for replacing
`deploy-secrets.zip`: build the new zip in `/tmp`, then `cp` it over.

---

### The Sell menu still renders cards instead of one row per item

**Symptom:** `ko_pos_ui` ships the list styling from `design_handoff_ko_pos_ui` §1 and the
deploy is clean, yet every menu item is a block with the image above the name — the menu
does not read as one dish per line.

**Cause:** Odoo 19 passes `class="pos.productViewMode"` to every `ProductCard`. That getter
returns the Bootstrap utility `flex-column` (and, when a small-screen list view is
configured, `flex-row-reverse justify-content-between m-1`). Bootstrap utilities are
`!important`, so they beat a plain `flex-direction` in the addon stylesheet. The KO rule
set `display: flex` and `align-items: center` but never pinned the direction, so the card
kept stacking.

**Fix (`ko_pos_ui` 19.0.4.2.0):** state the row layout explicitly on `.ko-product-card` —
`flex-direction: row !important`, `justify-content: flex-start !important`,
`text-align: left !important`, `margin: 0 !important` — and keep `.product-content` /
`.product-name` left-aligned, because Odoo centers the no-image variant. Odoo's own
`.product-cart-qty` badge is hidden; the KO row shows the stepper instead.

**Rule of thumb:** when styling anything Odoo renders through a `class="…"` prop, read what
that prop actually contains. Any Bootstrap utility in it wins over a normal declaration,
and the property it controls has to be restated with `!important`.

---

### A deployed POS CSS/JS change is invisible in a browser that already had the POS open

**Symptom:** the deploy log shows the new `DEPLOYED_ko_pos_ui` version, fetching the bundle
with `cache: 'reload'` returns the new CSS, but the open POS tab still renders the old UI
after a normal reload.

**Cause:** the POS registers service workers and keeps `odoo-sw-cache` / `odoo-pos-cache`,
and its stylesheet URL (`/web/assets/debug/point_of_sale.assets_prod.css`) carries no
version segment, so the browser happily reuses the copy it already has.

**Fix / verification recipe:** hard-reload the POS tab (`Cmd/Ctrl + Shift + R`). To be
certain, clear the caches first from the page console:

```js
for (const r of await navigator.serviceWorker.getRegistrations()) { await r.unregister(); }
for (const n of await caches.keys()) { await caches.delete(n); }
```

then reload. **Never conclude a UI fix failed until you have done this** — and tell the
owner that every till already sitting on the POS needs one hard refresh after a UI deploy.

**The JS bundle needs one more step (seen 2026-08-23).** Clearing the service workers and
caches was not enough: `point_of_sale.assets_prod.js` was still served from the browser's
ordinary HTTP cache, so `posmodel` existed but the KO patches (`koKdsChanges`,
`koSendToKds`) were `undefined` while the same URL fetched with `cache: 'reload'` clearly
contained them. Revalidate the bundle first, then reload:

```js
for (const s of [...document.querySelectorAll('script[src]')].map(s => s.src)) {
    await fetch(s, { cache: 'reload' });
}
location.reload();
```

Checking `typeof posmodel.koSendToKds === 'function'` is the quickest proof that the tab is
running the deployed code.

---

### There is no ส่งครัว button at all, so orders can never reach the kitchen

**Symptom:** staff key an order in the POS and there is simply no way to send it to the
kitchen. On a table order the green action button says only ชำระเงิน. The KDS board stays
on "ไม่มีออเดอร์ค้าง" no matter what is rung up.

**Cause:** Odoo decides whether an order "has anything to send" from
`pos.config.preparationCategories`, which is derived **only** from the product categories
attached to a `pos.printer` record — see `addons/point_of_sale/static/src/app/models/pos_config.js`.
The restaurant `ActionpadWidget` renders the Send button behind
`t-if="… and this.displayCategoryCount.length"`. With no printer linked to the POS
(`pos.config.printer_ids` empty — which was true of **both** KO shops), that set is empty,
`categoryCount` is `[]`, the button never renders, and `order.hasChange` is always false so the
"send to preparation?" prompt before payment never fires either.

**Second half of the same trap:** even with a printer attached, only the categories listed
on that printer count. The KO seed printer lists อาหารจานเดียว / กับข้าว / ของหวาน but **not**
เครื่องดื่ม, so a drinks-only order was unsendable even on a till that had a printer.

**Fix (ko_pos_kds 19.0.6.0.0):** the KDS no longer borrows the printer's configuration.
`PosStore.getOrderChanges` is patched to use every POS category when `ko_kds_enabled` is on,
and `getCategoryCount` falls back to a single ครัว bucket so a product with no POS category
at all still shows the button. Printing keeps using `printerCategories` — untouched.

**Rule of thumb:** on this project the kitchen display and the kitchen printer are
independent. Never gate a KDS behaviour on `pos.printer`.

---

### The order was paid but the kitchen never saw it

**Symptom:** a takeaway is keyed and paid straight away. The receipt prints, the sale is in
บิลแล้ว, and the kitchen has no idea the food was ordered.

**Cause:** `OrderPaymentValidation.afterOrderValidation` in
`addons/point_of_sale/static/src/app/utils/order_payment_validation.js` sends the order to
preparation **only when `!config.module_pos_restaurant`**. In restaurant mode Odoo instead
asks, in `pos_restaurant`'s `pay()`, "It seems that the order has not been sent. Would you
like to send it to preparation?" — and **Discard is a valid answer**. Press Discard (or have
`hasChange` be false, see the gotcha above) and the money is taken while the kitchen is
never told.

**Fix (ko_pos_kds 19.0.6.0.0):** `afterOrderValidation` is patched to send in restaurant mode
too, and `_askForPreparation` is suppressed while
`pos.config.ko_kds_auto_send_on_payment` is on, so there is no dialog to dismiss. The two
supported paths are now: press ส่งครัว, or pay — either one reaches the kitchen.

---

### The kitchen board has two station rows that disagree

**Symptom:** `/kds/pos/<id>` shows a row of chips (ครัวร้อน / ครัวเย็น / เครื่องดื่ม) *and* a
"สถานี:" row of links. Picking a chip and picking a link give different results, and adding
a real station such as ครัวขนม is impossible.

**Cause:** two independent station concepts shipped at once. `pos.category.ko_kds_station`
was a hard-coded `Selection` of exactly three values that decided the badge on each dish and
the chip filter in the browser; `ko.kds.station` was a real model whose `category_ids`
filtered the same board on the server. Neither knew about the other.

**Fix (ko_pos_kds 19.0.6.0.0):** the selection field and the chips are gone.
`ko.kds.station` is the only station concept: `ko.kds.ticket.line.station_id` points at one,
routing is menu-item → category → catch-all, and the station bar is rendered from the real
records. A dish that matches no station is shown on **every** board as ไม่ได้กำหนดสถานี so a
configuration gap can never hide an order.

**If you upgrade a database that already had stations:** `ko_pos_setup` seeds ครัวร้อน /
บาร์น้ำ / ครัวขนม, which will sit next to whatever the shop already created. Decide which set
is real, map the survivors to their categories, and deactivate the rest (do not delete —
`noupdate="1"` data is recreated on the next upgrade if the record is missing).

---

### A legacy KDS line lands on the wrong station right after the upgrade

**Symptom:** immediately after deploying 19.0.6.0.0, an old ticket line shows a station that
has nothing to do with the dish.

**Cause:** `data/kds_migrate.xml` runs inside `ko_pos_kds`, which Odoo loads *before*
`ko_pos_setup` (73…88 order in the upgrade log). The stations that `ko_pos_setup` seeds do
not exist yet, so the migration can only put the line on whatever catch-all is already
there.

**Fix:** it only affects lines that existed before the upgrade. Re-point them by hand in
หลังบ้าน → ประวัติออเดอร์ครัว, or clear `station_id` and run the migration again once the
stations exist.

---

### The ขาย tab does nothing and the console says `Cannot read properties of undefined (reading 'uuid')`

**Symptom:** reported from production. Tapping **ขาย** in the KO bottom nav does nothing at
all; the browser console shows

```
TypeError: Cannot read properties of undefined (reading 'uuid')
    at KoBottomNav.goSell (…/point_of_sale.assets_prod.min.js)
```

**Cause:** `goSell()` did `this.pos.getOrder().uuid`, and **restaurant mode very often has
no current order**. `PosStore.getOrder()` returns `undefined` whenever `selectedOrderUuid`
is unset, and `afterOrderDeletion()` only re-selects an order when
`module_pos_restaurant` is **off**. So opening the POS onto the floor plan, or finishing
or clearing a sale, leaves nothing selected — and the very next tap on ขาย throws.

**Reproduce (takes a minute):** open the POS → floor plan → tap บิล → tap ขาย.

**Fix (`ko_pos_ui` 19.0.5.0.1):** guard the read, and pick a sensible destination when
there is no order:

- an order in hand → back to that order's ProductScreen (unchanged);
- restaurant mode with nothing selected → **FloorScreen**, so staff pick a table;
- otherwise → `pos.defaultPage`.

**Do not** reach for `pos.openOrder` as the fallback. It returns
`models["pos.order"].find(o => o.state === "draft")` — in a restaurant that is very
likely *another table's* draft order, so the ขาย tab would silently drop the cashier into
someone else's bill.

`ko_receipt_screen.js` had the same unguarded read on the edit-bill path (an empty refund
intent restores no line, so no order exists) and is guarded the same way.

---

### An order in ออเดอร์ค้าง cannot be opened, so a dish can never be added or removed

**Symptom:** the owner reports "แก้ไขออเดอร์ไม่ได้ ถ้าจะลบหรือเพิ่ม". Tapping an order card
in the ออเดอร์ค้าง tab does nothing at all — no navigation, no error, nothing in the
console.

**Cause:** the KO TicketScreen replaces Odoo's entire screen body, and the replacement
card carried **no click handler**. Odoo's own `onClickOrder` / `onDblClickOrder` were
replaced along with the markup. The only interactive control on the card was the per-dish
เสิร์ฟ button. A table order could still be reopened from the floor plan by chance; a
**takeaway has no table at all**, so once keyed it could not be reopened from anywhere.

**Reproduce:** key a dish to a table, go to บิล → ออเดอร์ค้าง, tap the card. The URL does
not change and `posmodel.getOrder()` stays `null`.

**Fix (`ko_pos_ui` 19.0.6.0.0):** each unpaid card gets **แก้ไขออเดอร์** and a two-tap
**ยกเลิกออเดอร์**. Editing calls `TicketScreen.setOrder(order)` — Odoo's own helper, which
refuses while the order is syncing, flushes shared orders first, then selects and
navigates. Do not hand-roll `pos.setOrder` + `navigate` here; the sync guard matters.

Cancelling goes through a local `_koDeleteOrder` rather than `pos.onDeleteOrder`, because
`onDeleteOrder` opens its own **English** "are you sure" dialog on top of the card's Thai
two-tap confirm — two prompts for one decision, and in an automated test the second one
blocks forever. `_koDeleteOrder` keeps everything else `onDeleteOrder` does, including
`deleteOrders()` (which is what tells the kitchen) and clearing the `lineToRefund` entries
a deleted refund order leaves behind.

---

### A bill reads คืนเงินครบแล้ว the moment ยกเลิกบิล is tapped, and every button disappears

**Symptom:** tap ยกเลิกบิล once, walk away without taking the refund payment, and the
original bill now shows **คืนเงินครบแล้ว · Refunded**. Its whole action grid is gone: no
reprint, no tax invoice, no way to finish the refund and no way to undo it. The bill is
bricked.

**Cause:** `pos.order.line.refundedQty` in Odoo 19 is

```js
this.refund_orderline_ids?.reduce((acc, line) =>
    (line.order_id.state !== "cancel" ? acc - line.qty : acc), 0)
```

— it counts refund lines whose order is merely **`draft`**. Creating the refund order is
enough; no money has to move. Anything that decides "is this bill settled?" from
`refundedQty` therefore flips the instant the refund is *started*.

**Fix (`ko_pos_ui` 19.0.6.0.0):** `settledRefundQty(line)` counts only refund lines whose
order is `finalized`. Use that for the bill's status label and for dropping a bill out of
ออเดอร์ค้าง. An unfinished refund is a *third* state, not a settled one: the bill sheet
shows an orange banner naming the amount, with **ทำต่อ · จ่ายคืน** and **ทิ้งบิลคืนเงิน**,
and hides the refund buttons meanwhile so the same bill cannot be refunded twice.

**Related trap in the same area:** Odoo's `_getRefundableDetails` skips any
`uiState.lineToRefund` entry that already has a `destination_order_uuid`. An abandoned
refund therefore poisons every later attempt on that bill — the next refund comes out as
an **empty order for 0 บาท**. Clear `order.uiState.lineToRefund` before starting a new
refund. That is only safe because a *pending* refund is refused first; without that check
you would be dropping a live intent.

---

### The payment screen is the KO one on a phone and raw Odoo on a tablet

**Symptom:** the redesigned payment screen appears on a phone but a tablet or desktop
shows stock Odoo — Odoo's numpad, `ยืนยัน`/`กลับ` buttons, the payment-lines list. No
console error. The bundle contains the KO template, and every other KO screen renders
fine.

**Cause:** `point_of_sale.PaymentScreen` is **two whole screens in one template**:

```xml
<t t-name="point_of_sale.PaymentScreen">
    <t t-if="ui.isSmall">   <div class="payment-screen …">  …phone…   </div></t>
    <t t-else="">           <div class="payment-screen …">  …desktop… </div></t>
</t>
```

`<xpath expr="//div[hasclass('payment-screen')]" position="replace">` matches the **first**
node only, so it replaced the phone branch and left the desktop branch untouched.
ProductScreen, TicketScreen and ReceiptScreen each have a single root, which is why only
this screen was affected.

**Why it mattered beyond looks:** the KDS refund cancellation was wired to
`koValidatePayment`, the KO button. On a tablet the cashier validated through Odoo's own
button, so the kitchen was **never told about a refund at all**.

**Fix (`ko_pos_ui` 19.0.6.0.0):** target the branches, not the class —

```xml
<xpath expr="//t[@t-else='']" position="replace"/>
<xpath expr="//t[@t-if='ui.isSmall']" position="replace"> …KO screen… </xpath>
```

Remove the `t-else` first: a `t-else` with no preceding `t-if` is a template error.

**The wider lesson:** anything that must happen when an order is validated belongs on
`OrderPaymentValidation.afterOrderValidation`, not on a KO button. Behaviour must not
depend on which button the cashier happened to press. Check any replaced screen for a
second match with
`grep -c "class=\"<screen>-screen" <odoo>/addons/point_of_sale/static/src/app/screens/…`.

---

### The kitchen keeps cooking a dish that was refunded

**Symptom:** a bill is refunded — partly or in full — and the dishes are still on the
kitchen board. The refunded order also stays in ออเดอร์ค้าง with live เสิร์ฟ buttons.

**Cause:** two gaps. `koSendToKds` returns early for `order.isRefund`, so a refund order
never reaches the KDS at all; and the only cancellation call was on a KO button that does
not exist on wide screens (previous entry).

**Fix (`ko_pos_kds` 19.0.7.0.0):** `ko.kds.ticket.cancel_lines_from_pos(order_uuid,
refunded_lines, config_id)` takes the **original** order's line uuids — with quantities
when only part of a line came back — and cancels exactly those. A line only partly
returned has its `qty` reduced instead of being struck off. When nothing is left alive the
ticket closes; when a partial refund leaves work behind on an already-cancelled ticket, the
ticket returns to `progress`.

It is called from `PosStore.koCancelKitchenForRefund`, driven by
`afterOrderValidation` — every refund, every screen width. Refund lines carry
`refunded_orderline_id`, which is how the original line and its order are recovered.

Deleting an unpaid order is handled separately: `deleteOrders()` already fires
`sendOrderInPreparation({cancelled: true})`, but that diff only knows the dishes **this
device** remembers sending, so a dish fired from another till survived it. The
`sendOrderInPreparation` patch now also calls `cancel_by_order_uuid`, which closes the
ticket outright. Cancelling an already-cancelled ticket is a no-op, so doing both is safe.

---

### One new .scss file breaks the entire POS stylesheet

**Symptom:** after adding a new `.scss` file to `ko_pos_ui/static/src/app/`, the POS
renders unstyled with a red bar reading **"A css error occured, using an old style to
render this page"**. The Odoo log says

```
Error: Invalid CSS after "...tic/src/app/**/": expected 1 selector or at-rule
```

**Cause:** the file's header comment was a C-style block comment that mentioned the asset
glob `ko_pos_ui/static/src/app/**/*`. A SCSS block comment ends at the **first** `*/` — and
`**/` is one. Everything after it was parsed as CSS, so the whole bundle failed and Odoo
fell back to the previous stylesheet.

**Fix:** use `//` line comments in `.scss` files, or never write `*/` (including inside a
glob) within a block comment. The failure is loud in the log but easy to misread as
unrelated, because it names the bundle rather than your file.

**Worth knowing anyway:** a new file under `static/src/app/` needs no manifest change —
the glob picks it up — and files load in alphabetical order, so `ko_pos_ui_orders.scss`
lands after `ko_pos_ui.scss` and its additive rules win.

---

### Refunding a bill turned a live table into a refund

**Symptom:** a waiter opens table 12, and while its blank order is still sitting there
someone refunds an unrelated bill. Table 12's order *becomes* the refund — same uuid, still
attached to the table.

**Cause:** `TicketScreen._getEmptyOrder()` reuses **any** empty draft order as the refund's
destination, and in a restaurant the most common empty draft order is the one tapping a
table just created.

**Reproduce:** pay a bill, tap an unused table to create its blank order, go to บิลแล้ว and
refund the bill. Check `posmodel.getOrder()` — before the fix its `uuid` is the table's
order and `table_id` is that table. Confirmed on the disposable database:
`{"hijacked":true,"refundTable":12}`.

**Fix (`ko_pos_ui` 19.0.6.1.0):** `_getEmptyOrder` is overridden to reuse only orders with
no `table_id` and no `is_refund`; otherwise it creates a fresh one.

---

### "แก้ไขบิล" refunds the money and gives nothing back

**Symptom:** the edit-bill flow refunds the bill, the receipt screen offers
**โหลดรายการเพื่อแก้ไข · Edit order**, and tapping it lands on the floor plan with no order
and no lines. The console shows:

```
Error: Finalized Order cannot be modified
    at Proxy.assertEditable
    at Proxy.addLineToCurrentOrder
    at ReceiptScreen.koNewOrder
```

**Cause:** `koNewOrder()` called `orderDone()` and *then* `addLineToCurrentOrder()`.
`orderDone()` navigates to `pos.defaultPage`, which in restaurant mode is FloorScreen — and
`navigate()` only re-points `selectedOrderUuid` when the target route carries an
`orderUuid`. FloorScreen's route carries none, so the POS was still pointing at the refund
order it had just finalized. FloorScreen's `resetTable()` clears it, but only after the
component mounts — far too late.

**Fix (`ko_pos_ui` 19.0.6.1.0):** build the replacement order **before** `orderDone()`, with
`pos.createNewOrder()` (which does *not* select it, so the receipt screen keeps rendering
the refund), add the lines to it explicitly with `addLineToOrder(vals, order)`, and select
and navigate to it afterwards. The intent also carries `tableId` and `partnerId`, so an
edited dine-in bill comes back on its own table instead of turning into a takeaway.

**Know what the button costs before offering it.** It cancels the old kitchen ticket (the
refund does that) and fires the corrected order as a **new** ticket, so every unchanged dish
is cooked again. It is the right tool for a bill keyed against the wrong table, and the
wrong tool for swapping one plate — refund that one line instead.

---

### Tapping บิล freezes on the previous screen for a second or more

**Symptom:** every time staff tap **บิล**, the till sits on whatever screen it was
already showing, then flips to the orders tab. It never gets faster on repeat taps, and it
gets worse as the day fills up with bills. Going the other way (ขาย) is instant.

**Measured** on a disposable Odoo 19 database at 120 ms RTT with 61 bills in the session:
บิล took **1,334 ms** to paint, every single time; ขาย took **77 ms**.

**Cause:** `TicketScreen` fetched everything in `onWillStart`, and **OWL paints nothing
until every `onWillStart` promise resolves**. In restaurant mode that is six sequential
round trips before a single pixel:

| # | call | where from |
| --- | --- | --- |
| 1–2 | `syncAllOrders({table_ids})` then `syncAllOrders()` → `pos.config/notify_synchronisation` ×2 | `pos.getServerOrders()`, restaurant override + base |
| 3 | `loadServerOrders(draft)` → `pos.order/read_pos_orders` | `pos.getServerOrders()` |
| 4–5 | `pos.order/search_paid_order_ids` + `read_pos_orders` | KO `_fetchSyncedOrders()` |
| 6 | `ko.kds.ticket/get_pos_status` with **every** order uuid in memory | KO `koRefreshKdsStatus()` |

And it could not warm up: the screen reset `screenState.ticketSCreen.totalCount` and
`offsetByDomain` on every mount, so page 1 was re-fetched from scratch each time.

**Fix (`ko_pos_ui` 19.0.6.2.0, `ko_pos_kds` 19.0.7.1.0):**

- the fetch moved from `onWillStart` to `onMounted` and is no longer awaited by anything
  that renders. The tab paints immediately from the orders already in memory, shows
  **กำลังอัปเดต…** while the rest arrives, and the three calls now go out together instead
  of one after another;
- `PosStore.getServerOrders()` is patched to return an already-resolved promise and do its
  work behind the screen (deduplicated, and skipped if it ran in the last 8 seconds), so no
  screen — not only this one — can be held back by it;
- `koRefreshKdsStatus` only asks about orders that could still have something live on the
  kitchen board. An order is dropped once it has been answered for and has nothing
  outstanding; anything that touches the kitchen for it calls `koMarkKitchenDirty` to put it
  back. The payload went from 30 orders on every single refresh to 30 once, then 0.

**Result:** 1,334 ms → **52–144 ms** to paint, and a second tap inside the throttle window
fires **no RPC at all**. A **↻ รีเฟรช** button in the header forces a refresh when staff
want one.

**The lesson for any screen in this POS:** `onWillStart` is a rendering barrier. Anything
that talks to the server belongs in `onMounted` (or later), unless the screen genuinely
cannot be drawn without the answer.

---

### The bill sheet gets sluggish as the day goes on

**Symptom:** with the bill sheet open, each tap on a `+`/`−` refund stepper takes a
noticeable moment — and it gets worse the more bills the session has.

**Measured:** with 30 orders in memory, one stepper tap took **226 ms** to re-render.

**Cause:** `koSelectedTicket` was implemented as
`this.koBilledOrders.find(t => t.order.uuid === uuid)`, and the template reads
`koSelectedTicket` **fifteen times** per render. Each read rebuilt the entire billed list —
every order, every line, every refund total — so one render did seventeen full passes over
the session, and OWL re-renders on every state change.

**Fix (`ko_pos_ui` 19.0.6.2.0):** the per-order work is a single `_koBillTicket(order)`
helper; `koSelectedTicket` looks the order up by uuid and builds that one ticket (O(1)); the
template computes `koOpenOrders` and `koSelectedTicket` once into `t-set` variables and
reads those. The billed list also renders 40 rows at a time with a **โหลดบิลเก่ากว่านี้**
button, instead of putting every finalised order of the day in the DOM.

**Result:** 226 ms → **59 ms** per tap, and it no longer grows with the number of bills.

---

### Half a stylesheet quietly stops applying, and the page still looks *almost* right

**Symptom.** After editing `kds_templates.xml` the board rendered, the fonts were right and
most rules worked — but every touch target was the wrong size. `getComputedStyle` said
`min-height: auto` where the source clearly said `min-height: var(--tap)`, and a `<button>`
had Chrome's UA `padding: 1px 6px` despite a `* { padding: 0 }` reset.

**Cause.** A block comment in the `<style>` was closed with `-->` instead of `*/`:

```css
/* ------------------------------------------------
   Design notes ...
   ------------------------------------------------ -->     <-- WRONG
:root { --tap: 56px; ... }
* { margin: 0; padding: 0; }
```

CSS has no `-->` terminator, so the comment ran on and swallowed `:root`, `*`, `html`,
`body` and `button` until the **next** `*/` in the file — the header section comment. The
page kept working because everything after that point still applied; the missing
`:root` only showed up as `var(--tap)` resolving to nothing, which makes the whole
declaration invalid at computed-value time and silently falls back to `auto`.

**Catch it in one line** — the rule count is the tell:

```js
// in the browser, on the KDS page
Array.from(document.querySelectorAll('style'))
     .find(s => s.textContent.includes('--ko-teal-soft')).sheet.cssRules.length
```

If that number is lower than the number of rules you wrote, a comment is eating them.
`grep -c '/\*'` vs `grep -c '\*/'` inside the `<style>` block must also match.

Related: `.scss` files must never contain `*/` **inside** a block comment either — the
bundle breaks the other way round. Use `//` in SCSS.

---

### A raw frontend page's own CSS class is overruled by Bootstrap, so an element never appears

**Symptom.** The KDS toast (and its **เลิกทำ** undo button) existed in the DOM with the right
text and a non-zero opacity, but Playwright reported it as hidden and nothing was visible on
screen. `getComputedStyle(el).display` was `none` even though the page's own rule said
`display: flex`.

**Cause.** `/kds/pos/<id>` is a standalone page that pulls in `web.assets_frontend`, and that
bundle contains **Bootstrap**. Bootstrap ships `.toast:not(.show) { display: none }`, which
has specificity (0,2,0) and beats a plain `.toast { display: flex }` at (0,1,0) — the page's
stylesheet coming later in the cascade does not help, because specificity is compared first.
`.nav` collides the same way.

**Rule.** On any page that calls `t-call-assets="web.assets_frontend"`, do not use a bare
Bootstrap class name for your own component. `ko_pos_kds` prefixes the ones that clash:
`.k-toast`, `.k-toasts`, `.k-nav`.

**Find every collision on the page** — do not guess from a list of Bootstrap class names,
because `:not()` and attribute forms will not show up in a text search. Ask the browser which
foreign rules actually match your elements:

```js
const odoo = document.styleSheets[0];              // web.assets_frontend.min.css
const rules = [];
const walk = r => { if (r.cssRules && r.type !== 1) return Array.from(r.cssRules).forEach(walk);
                    if (r.selectorText && r.style && r.style.cssText) rules.push(r); };
Array.from(odoo.cssRules).forEach(walk);
document.querySelectorAll('body *').forEach(el => rules.forEach(r => {
  try { if (el.matches(r.selectorText)) console.log(r.selectorText, '->', r.style.cssText, el.className); }
  catch (e) {}
}));
```

Anything that comes back with a **class** selector (as opposed to `button`, `a`, `h2`) is a
name to rename. `/root/kdstest/who2.js` in the sandbox is this check wrapped in Playwright.

---

### `pkill -f odoo-bin` / `pkill -f "http-port=8069"` kills the agent's own shell (exit 144)

Already noted for `odoo-bin`, but it bites for **any** pattern that also appears in the
command line the tool wraps around your command — including the port number. Kill Odoo by
its TCP listener instead, never by a command-line pattern:

```bash
PIDS=$(ss -lptnH "sport = :8069" | grep -oP 'pid=\K[0-9]+' | sort -u)
[ -n "$PIDS" ] && kill $PIDS
```

---

### Beam Bolt accepts a payment, but POS cancellation returns 405 or can create a duplicate

**Symptom:** cancelling a Bolt Intent returns HTTP 405, or a network timeout followed by
Retry creates a second payment request for the same bill.

**Cause:** Beam API v1 cancels Bolt Intents with
`PATCH /api/v1/bolt-intents/{boltIntentId}/cancel`, not `POST`. A create request that
times out is also ambiguous: Beam may have created the intent even though Odoo received no
response. Retrying with a new idempotency key is a duplicate-payment risk.

**Fix (`ko_pos_beam_bolt` 19.0.2.0.0):** every Beam `POST` and `PATCH` sends
`x-beam-idempotency-key`. Until Beam returns the intent ID, POS persists that key as
`beam-idem:<key>` in the payment line's standard transaction field. Retry repeats the same
request; Cancel first repeats it with the same key to recover the authoritative intent ID,
then sends the correct `PATCH`. Do not clear this marker or create another payment method
while the result is uncertain.

Two related Beam rules belong in the operating procedure:

- Playground and Production have separate credentials and connections. Disconnect before
  switching environment, then log in and pair the device again.
- A Bolt Intent sent while the device is not on **Ready to accept payments** is discarded.
  Wait at least five seconds after connect, cancel, or expiry before creating another one.

---

### Deploy succeeds, but the log cannot prove which Beam Bolt version landed

**Symptom:** Odoo reports that `ko_pos_beam_bolt` loaded, but the deploy log contains no
manifest version, so it cannot prove whether production cloned the intended commit.

**Cause:** Odoo's normal module-loading line shows the module name and loading position,
not its manifest version. The Compose init service originally echoed only KDS and UI.

**Fix (2026-08-25):** `deploy_real/vps-compose-git.yaml` inside `deploy-secrets.zip`
now prints `DEPLOYED_ko_pos_beam_bolt` and its manifest version immediately after cloning
`main`. Require that signal on every Beam deployment; action success or a generic module
load line is not version verification.

---

### Beam Bolt+ is missing from the first `การผสานรวม` dropdown

**Symptom:** the Odoo payment-method form offers only `ไม่ต้องระบุ`, `เครื่องรูดบัตร`,
and `แอปธนาคาร (QR)` under `การผสานรวม`, so Beam appears not to be installed.

**Cause:** Odoo 19 uses two dependent selections. The first field chooses the integration
class, not the terminal provider. Provider choices stay hidden until terminal mode is active.

**Fix:** choose `เครื่องรูดบัตร` in `การผสานรวม`; Odoo then reveals `ผสานรวมกับ`, whose
options include `Beam Bolt+`. This exact two-step flow was verified live on payment method
id 8 on 2026-08-25; the inspection was discarded without saving.
