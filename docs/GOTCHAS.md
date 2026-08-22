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

### The site looks down from the sandbox

**Symptom:** `curl https://kodoo.viakuma.com` from the agent container returns 403 or hangs.

**Cause:** the sandbox has an egress allowlist that does not include this domain. It is a
sandbox restriction, not an outage.

**Fix:** verify through browser tooling or WebFetch. Do not report an outage based on a
sandbox fetch, and do not try to route around the block with other HTTP clients.

---

### I fixed the addon but nothing changed

**Symptom:** Code edited in `addons/`, pushed, deployed — no effect.

**Cause:** `addons-init` prefers `addons.tar.gz` and only falls back to `addons/` if the
tarball is absent. The tarball is present, so deployment ignores `addons/`. That folder
currently contains a partial copy of `ko_pos_thai_lang` plus a reviewable source copy of
`ko_pos_ui`, which makes it look deceptively authoritative.

**Fix:** edit inside `addons.tar.gz`. Better: do the AGENTS.md §4 cleanup and remove the
ambiguity for good.

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

**Fix:** the only route is the normal one — open the session, then close it. For an empty
session (0 orders, 0.00 opening cash) this is harmless: the close dialog shows all zeros
and no revenue is posted. It does consume a session number, so a
`My Company/000NN` with zeros will appear in the session list; that is expected, not a bug.

Path: Dashboard → **เปิดรอบ** → POS loads → dismiss the order-type dialog **without
creating an order** → ☰ menu → **ปิดรอบ** → confirm the zeros → **ปิดรอบ**.

**Do not** try to work around this by deleting the row through the ORM. The UI omission is
intentional, and a human should decide anything that touches session records.

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
