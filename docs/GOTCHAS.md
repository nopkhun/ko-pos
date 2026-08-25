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

### Beam Bolt Android shows an eight-digit Pairing code, but Odoo requires six digits

**Symptom:** the current Android app displays an eight-digit Pairing code, while Odoo
rejects it with “รหัส Pairing ต้องเป็นตัวเลข 6 หลัก”.

**Cause:** the addon treated the documentation's six-digit example as a protocol
constraint. Beam OpenAPI v1.22.0 actually defines `pairingCode` only as a string, with no
length or numeric pattern.

**Fix (`ko_pos_beam_bolt` 19.0.2.0.1):** require only a non-empty code and forward the
trimmed value exactly to Beam. The form label and help no longer claim six digits, and the
Odoo regression test pairs with a synthetic eight-digit code. Beam remains the authority
that accepts or rejects an expired or invalid code.

---

### Adding PromptPay after Card asks to Pair the same Beam Bolt again

**Symptom:** one Odoo payment method has already paired the device for Card. Creating a
second method for QR PromptPay shows another Pairing field, but the app cannot enter Pairing
Mode because it is already connected.

**Cause:** versions through `ko_pos_beam_bolt` 19.0.2.0.1 stored credentials and
`boltConnectionId` directly on each `pos.payment.method`. Beam's model is the reverse: Pair
once to create a device connection, then send each Bolt Intent with that same connection ID
and a different `paymentMethod`.

**Fix (`ko_pos_beam_bolt` 19.0.3.0.0):** the first payment method remains the connection
owner. Additional Card, PromptPay, installment, or wallet methods select it in
**ใช้การเชื่อมต่อ Beam จาก** and reuse its credentials, environment, Device ID, and Bolt
Connection ID while keeping their own payment type and expiry. The addon blocks Pair or
Disconnect on a dependent method, cross-company sharing, chained sharing, and disconnecting
an owner that still has dependents. Never copy connection IDs into the database manually.

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
options include `Beam Bolt+`. This exact two-step flow and the shared-connection field were
verified live on current payment method id 5 on 2026-08-25; the inspection did not change
the record.

---

### A saved Odoo payment-method URL says the record no longer exists after Beam setup

**Symptom:** opening a previously saved URL such as `/odoo/action-559/8` returns
“ดูเหมือนว่าไม่พบบันทึก...” even though Beam payment still exists in the Payment Methods
list.

**Cause:** payment-method record IDs are database row identities, not stable configuration
names. The prepared Beam records id 8/id 9 were removed or replaced; production now uses
connected owner id 5, `บัตรเครดิต`. A stale bookmark is not evidence that the addon or
connection disappeared.

**Fix:** return to the Payment Methods list and open the current record by name. Before any
Pair, Disconnect, or dependent-method setup, verify its environment, connected status,
Device ID, and POS assignments. Update runbooks when the live record changes; never infer
current IDs from an old URL.
