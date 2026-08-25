# KO POS — Agent Handoff / คู่มือส่งต่องานสำหรับ AI

> **Read this file first.** It is the canonical brief for any AI agent (Claude, Codex,
> ChatGPT, Gemini, Antigravity, Cursor, …) picking up this project. Everything here was
> verified against the running production system, not inferred.
>
> **สรุปภาษาไทย:** โปรเจคนี้คือระบบ POS ร้านอาหาร (Odoo 19) รันจริงบน Hostinger VPS ที่
> https://kodoo.viakuma.com — ใช้งานจริงแล้ว มี addon ของเราเอง 5 ตัว และระบบคำแปลไทย
> "ฉบับร้านอาหาร" ที่เขียนเอง อ่านหัวข้อ *Do not break these* ก่อนแก้อะไรทั้งสิ้น

- **Last verified:** 2026-08-23 (order control buttons)
- **Status:** LIVE in production. A real restaurant will use this.
- **Owner:** Nop (Thai speaker — user-facing strings and all UI copy must be natural Thai)

---

## 0. Definition of done — update everything, every time

**A task on this project is not finished when the code works. It is finished when the
written record matches reality.** After *any* change — a deploy, a wording fix, a config
change, or simply discovering a new trap — do all of this before reporting back:

1. **Push to the repo.** `addons-init` clones `main` on every deploy; anything unpushed
   does not exist as far as production is concerned.
2. **Update §8 *Current state*** with what is now verified true.
3. **Update §9 *Outstanding work*** — delete what you finished, add what you uncovered.
4. **Add to `docs/GOTCHAS.md`** if you lost time to something surprising. Write it
   symptom-first. The next agent will hit the same wall otherwise.
5. **Update the relevant `docs/RUNBOOK-*.md`** if the procedure itself changed.
6. **Update `CREDENTIALS.local.md`** if a password, key, ID, or placeholder changed.
7. **Update *both* copies.** These docs exist in the owner's local `KO-DOO` folder *and*
   in the repo. Update both in the same session or they drift apart silently.
8. **Update your own persistent memory**, if your tool has one.

Then say plainly what you verified and what you did **not**. "Project deployed
successfully" is not verification — it only means containers started. See §6.

<sub>เจ้าของโปรเจคขอไว้ชัดเจน: ทำงานอะไรเสร็จ ให้อัปเดตเอกสารทุกไฟล์ให้ตรงกับของจริงทุกครั้ง</sub>

---

## 1. What this is

An Odoo 19 restaurant point-of-sale deployment for a Thai restaurant, with six
custom addons and a hand-built Thai translation layer that replaces Odoo's stock
Thai with real Thai restaurant vocabulary.

| Thing | Value |
| --- | --- |
| Public URL | https://kodoo.viakuma.com |
| Odoo version | 19.0 (image `odoo:19`) |
| Database in use | `kopos` |
| Old databases (still on disk, unused) | `ko_pos`, `kodoo` — delete only when the owner confirms |
| Host | Hostinger VPS, `virtualMachineId` **973354**, hostname `srv973354.hstgr.cloud` |
| Docker Compose project | **`odoo-5qm8`** |
| Git remote | `git@github.com:nopkhun/ko-pos.git` (private) |
| Reverse proxy | Traefik, shared with other projects on the same VPS |

---

## 2. Architecture

Four services in one Compose project. Two are one-shot init containers that must
exit successfully before Odoo starts.

```
addons-init (alpine/git, one-shot)
  └─ clones main with the read-only SSH deploy key embedded in the local Compose
  └─ wipes /mnt/extra-addons and copies the repo's addons/ directory into it
      (exits 1 if /tmp/repo/addons is missing — no silent fallback)
  └─ echoes the deployed ko_pos_kds / ko_pos_ui manifest versions into the log
  └─ makes /mnt/extra-addons readable by the non-root Odoo user
      (the patch/thai_v2 + thai_v3 pipeline was folded into addons/ and
       deleted on 2026-08-23)
        ↓ (service_completed_successfully)
odoo-upgrade (odoo:19, one-shot)
  └─ uses an explicit --addons-path ending in /mnt/extra-addons
  └─ -d kopos --stop-after-init -i/-u <6 modules> --load-language=th_TH
  └─ this is where translations actually land in the database
        ↓ (service_completed_successfully)
odoo (odoo:19, long-running)
  └─ -d kopos --db-filter=^kopos$ --proxy-mode, port 8069 behind Traefik
  └─ uses the same explicit --addons-path as odoo-upgrade
  └─ entrypoint injects admin_passwd into /etc/odoo/odoo.conf

db (postgres:17-alpine) — healthcheck gates all of the above
```

Named volumes: `odoo-data` (filestore), `odoo-addons` (`/mnt/extra-addons`), `db`.

`/mnt/extra-addons` is **rebuilt from scratch on every deploy** (`rm -rf /mnt/extra-addons/*`).
Never hand-edit files inside that volume expecting them to survive. Change the modules
under `addons/` and push `main` before deploying.

---

## 3. The six custom addons

All live in `addons.tar.gz` at the repo root.

| Module | Purpose |
| --- | --- |
| `ko_pos_setup` | Restaurant seed data: POS categories, floors/tables, demo products |
| `ko_pos_thai_receipt` | Thai abbreviated tax invoice (ใบกำกับภาษีอย่างย่อ) receipt layout |
| `ko_pos_kds` | Kitchen Display System (jaw-krua / จอครัว). One screen = one POS: `/kds` is a shop picker, the board is `/kds/pos/<config_id>` |
| `ko_pos_beam_bolt` | Beam Bolt+ terminal integration. One paired connection can be shared by multiple payment methods from 19.0.3.0.0 onward. |
| `ko_pos_thai_lang` | The Thai translation override layer — see §5. Depends on all four above. |
| `ko_pos_ui` | Touch-first restaurant POS interface: list-first Sell screen, current-order panel, prices, payment emphasis, responsive tablet/mobile layout. Presentation only; it does not change order, tax, or payment logic. |

---

## 4. Repository layout (`nopkhun/ko-pos`, branch `main`)

```
addons/                    ← deployment source of truth (all 6 modules). addons-init
                              copies this directory into /mnt/extra-addons.
addons.tar.gz              ← ⚠️ historical since 2026-08-23. NOT read by deployment.
                              Kept as a convenience snapshot only; a repacked tarball
                              is NOT a deploy. Do not reintroduce a fallback to it.
AGENTS.md                  ← this file
docs/                      ← runbooks, see below
```

**Why the flip:** an agent session can only push *text* through the GitHub MCP, so a
binary `addons.tar.gz` in the repo could never be refreshed from here. Preferring it meant
a pushed-and-deployed change could silently run old code. `addons/` is text, reviewable in
a diff, and always current.

### History of the `patch/` directories (deleted 2026-08-23)

`patch/thai_v2/` (base64 tarball chunks) and `patch/thai_v3/` (appended `.po`
fragments) existed because the only write path into this repo from the agent session
was a GitHub MCP tool that accepts **text content inline only**. There was also a
third hidden delivery path: a base64 tarball of `ko_pos_setup` files embedded
**inline in the Compose file itself**. On 2026-08-23 all three were folded into
`addons.tar.gz`, the patch directories were deleted, and the deploy Compose
no longer does any patch handling. The working Compose is now
`vps-compose-git.yaml` in `deploy-secrets.zip`; it clones `main` and unpacks only
`addons.tar.gz`. The attempted inline `vps-compose-simplified.yaml` is historical and
cannot be sent through Hostinger's 8,192-character API field. Old mechanics remain in
`docs/RUNBOOK-translations.md` for historical reference only.

---

## 5. The Thai translation layer — read before touching any wording

Odoo 16+ does **not** store Python/JS translations in the database; they are read from
`.po` files on disk at runtime. That single fact drives the whole design.

`ko_pos_thai_lang/i18n_overrides/` holds **57 `.po` files**. The filename is the target
module (`account.po` overrides the `account` module, `point_of_sale.po` overrides
`point_of_sale`, …). Two mechanisms consume them:

1. **Database / model terms** — `data/apply_overrides.xml` calls
   `<function model="ko.thai.lang" name="_apply_overrides"/>`, which runs Odoo's
   `TranslationImporter` with `overwrite=True` on every `-i` / `-u` of this module.
   This is what fixes field labels, selection values, menu names, view text.
2. **Python / JavaScript code terms** — `__init__.py` monkey-patches
   `CodeTranslations._load_python_translations` and `_load_web_translations` to merge
   the override files over Odoo's own. This is what fixes POS screen strings, buttons,
   and toast messages. It fails soft: if the patch raises, you get stock Thai, not a crash.

**Success signal in the deploy log — always check for this line:**

```
odoo.addons.ko_pos_thai_lang.models.thai_lang: ko_pos_thai_lang: applied Thai override translations from 57 files
```

If the file count is wrong, the patch pipeline silently under-delivered. Investigate
before believing anything else in the logs.

### What a `.po` override can and cannot fix

| Symptom | Fixable via `.po`? |
| --- | --- |
| Field label, selection value, menu item, button, POS screen text | ✅ yes |
| A record's **name** that a user or setup wizard created (e.g. a payment method called "การ์ด") | ❌ no — that is row data in the DB, edit it in the UI |

This distinction has already cost time once. Check which kind you are looking at before
writing a `.po` entry.

### Thai vocabulary decisions (do not silently revert these)

Chosen by surveying POS products Thai restaurants actually use — Loyverse, FoodStory,
Ocha, TOBIPOS — not by literal translation.

| English | Use | Never use |
| --- | --- | --- |
| Posted | ลงบัญชีแล้ว | โพสต์ |
| Card | บัตรเครดิต | การ์ด |
| State / Status | สถานะ | รัฐ *(รัฐ is correct only for address province fields)* |
| Session | รอบขาย | เซสชั่น |
| Order (POS) | ออเดอร์ | คำสั่งซื้อ |
| Order (purchase) | ใบสั่งซื้อ | คำสั่งซื้อ |
| Product | สินค้า | ผลิตภัณฑ์ |
| Journal | สมุดบัญชี | สมุดรายวัน |
| Floor | โซน | ชั้น |
| Fired (kitchen) | สั่งทำแล้ว | — |
| Settle | เคลียร์บิล | — |
| Change (money) | เงินทอน | — |

---

## 6. Deploying

Full step-by-step with verification in **`docs/RUNBOOK-deploy.md`**. The short version:

Deployment replaces the whole Compose project via the Hostinger API
(`VPS_createNewProjectV1`, `project_name: odoo-5qm8`, `virtualMachineId: 973354`).

> ⚠️ **You MUST pass the `environment` parameter on every call.** The call *replaces*
> the project; omitting `environment` silently wipes `DB_PASSWORD` and `TRAEFIK_HOST`,
> and the stack comes up broken. Values are in `CREDENTIALS.local.md` (local only).

Then poll `VPS_getActionDetailsV1` until `state: success`, and read
`VPS_getProjectLogsV1` — **do not trust "Project deployed successfully" alone**, it only
means containers started. Verify the translation count line from §5 and check the app.

---

## 7. Do not break these

1. **Compose eats `$`.** Any shell variable inside a Compose `command:` block must be
   written `$$VAR`, not `$VAR`. Docker Compose interpolates `$VAR` first and substitutes
   an empty string. This already caused a silent no-op deploy: a `for m in …; do` loop
   using `$m` matched nothing, the logs showed no error, and only the build-log warning
   `The "m" variable is not set. Defaulting to a blank string.` gave it away. Grep the
   build log for `variable is not set` after every deploy that touches a shell block.
2. **Never commit the SSH deploy key or any local Compose file.** The current working
   Compose lives in `deploy-secrets.zip` as `deploy_real/vps-compose-git.yaml` and
   contains the deploy key. Older Compose files are retained only for history. The repo
   must never contain any of them.
3. **Never put passwords in the repo.** `CREDENTIALS.local.md` is local-only.
4. **Do not touch the Traefik labels.** Traefik is shared with other projects on this VPS;
   changing router names or rules can take unrelated sites down.
5. **Do not pass `--i18n-overwrite`** on the Odoo update command. Our hook runs last and
   manages overwriting itself; that flag lets stock Thai clobber our overrides.
6. **Do not close a POS session that has real sales** (`รอบขาย`) to unblock an edit.
   Closing such a session posts real accounting entries and is the restaurant's decision,
   never the agent's. An empty session is a different matter — see `docs/GOTCHAS.md`.
7. **Ask before deleting the `ko_pos` / `kodoo` databases.**
8. The agent sandbox **cannot reach `kodoo.viakuma.com` directly** (egress blocked, 403).
   Verify the live site through the browser tooling or WebFetch instead. Do not
   conclude the site is down from a sandbox `curl` failure.
9. **Never scope a KDS query by accident.** `ko.kds.ticket` has no implicit POS filter.
   Any new search must carry `('config_id', '=', …)`, and `/kds/data` must keep answering
   `400 config_required` instead of falling back to "all tickets" — that fallback was the
   bug that put one shop's orders on another shop's kitchen screen.
10. **Keep `/mnt/extra-addons` explicit and readable.** Both Odoo commands must pass an
   `--addons-path` that includes `/mnt/extra-addons`, and `addons-init` must finish with
   `chmod -R a+rX /mnt/extra-addons`. The `odoo:19` image pulled on 2026-08-22 did not
   include the mounted path automatically; see `docs/GOTCHAS.md`.

---

## 8. Current state (verified 2026-08-25)

Working and confirmed against the live system:

- Backend UI is Thai throughout: menus, list views, invoice columns, status chips.
- `pos.session` has **0 of 60** field labels left in English; `pos.order` 2 of 92 (both
  internal UUID fields that are never displayed); `pos.payment` 1 of 33 (same).
- `Posted` → `ลงบัญชีแล้ว` and `Card` → `บัตรเครดิต` confirmed live.
- Five fields that wrongly rendered `State` as `รัฐ` now read `สถานะ`:
  `account.payment`, `account.lock_exception`, `payment.provider`, `mail.activity`,
  `report.stock.quantity`.
- Remaining `รัฐ` occurrences are address province fields (`state_id`, `state_ids`) where
  the word is correct.
- `account.move` still has ~29 untranslated deep technical fields (reconciliation
  internals, deprecated fields). Odoo upstream does not translate these either and they
  are not visible in normal use. Low priority.
- The POS payment method formerly named `การ์ด` is now **`บัตรเครดิต`** (record
  `pos.payment.method` id 5). This was DB row data, renamed through the Odoo UI, not a
  `.po` change. Verified in both `th_TH` and `en_US` — the record has a single stored
  name, so it reads `บัตรเครดิต` in both.
- Closed QA sessions through `My Company/00011` contain 0 orders and 0.00. Odoo 19 now
  leaves one new unnumbered session in `opening_control` (`เช็คเงินก่อนเปิดรอบ`) after
  closing from the POS because `pos.config.close_ui()` calls `open_ui()` again. It has
  no orders or payments and is ready for the next staff opening, but it counts as an
  open session for configuration locks. Do not repeat open/close trying to remove it;
  see `docs/GOTCHAS.md`.
- `ko_pos_ui` is deployed as the sixth custom addon. Production log on 2026-08-23
  confirms `Loading module ko_pos_ui (88/88)` and `Module ko_pos_ui loaded` with no
  upgrade error, traceback, invalid-module warning, or missing manifest.
- The touch-first UI keeps the order on the left and menu on the right on tablets,
  adds Thai workflow headings, horizontal categories, larger product cards with current
  prices, a prominent payment action, and a two-column mobile menu. Authenticated live
  QA passed at `1280×720` with no page overflow: the active category is green with white
  text, inactive categories remain distinct, and Thai product names/prices render. Local
  responsive QA also passed at `1024×768` and `390×844`.
- The high-fidelity **§1 Sell screen redesign is deployed** from commit `75ae107`.
  Final deploy action `110810391` succeeded: Postgres is healthy, Odoo is running,
  both init services exited 0, `ko_pos_ui` loaded, and Thai overrides remain exactly
  57 files. Production QA passed at `1280×800` and `390×844` for Thai search, category
  selection, plain-product add/merge, both quantity steppers, payment navigation without
  completing payment, and the mobile View order/cart switch. The phone document is
  exactly 390 px wide with no overflow, the header shows `ขายหน้าเคาน์เตอร์` and live
  session `#0020`, and no browser console warning/error was introduced.
- The live seed menu currently has no configurable product and no English
  `public_description`, so those two data-dependent §1 paths are not yet verifiable.
  After explicit confirmation, the unsent and unpaid QA draft line
  (`ข้าวกะเพราหมูสับ`, qty 1, 60.00 ฿) was removed. The current order is empty and
  session `#0020` remains open; nothing was sent to the kitchen or paid.
- Production Compose now passes `/mnt/extra-addons` explicitly to both Odoo processes
  and makes the mounted addon tree readable. Both init services exited 0, and the Thai override
  success signal remains exactly 57 files.
- **Company Profile Configured (verified 2026-08-23):** Company record and partner record
  updated to **`บริษัท น็อกเอาต์ จำกัด`**, address `2/67 ซอย ประเสริฐมนูกิจ 29 แยก 4 ถนนประเสริฐมนูกิจ แขวงลาดพร้าว เขตลาดพร้าว กรุงเทพมหานคร 10230`,
  and Tax ID `0105564168851` (Bangkok state TH-10). Odoo upgrade log confirmed
  `KO POS: Company info updated successfully: บริษัท น็อกเอาต์ จำกัด, VAT: 0105564168851`.
  Receipts and tax invoices dynamically format with these official details. Deploy action `110790895` completed with success.
- The Antigravity §2–§9 completion claim from commit `ffeb880` was audited and found
  not production-ready: the options were hard-coded instead of using Odoo attributes,
  payment/receipt retained stock mobile UI, billed orders disappeared after reload, and
  KDS failed on two Odoo 19 model assumptions. These defects are corrected and deployed
  in `ko_pos_ui` **19.0.4.0.0** and `ko_pos_kds` **19.0.4.0.2**.
- Final local QA uses a disposable Odoo 19/PostgreSQL database with the real addon and
  asset pipeline. It passed configurable-product add/edit/remove with real
  `product.attribute` values and `price_extra`, notes and quantity, phone cart,
  cash keypad/exact/change, payment validation, receipt/success, billed-order reload,
  full refund, two-tap void, and edit-bill refund followed by restoration of the original
  lines/modifiers/notes. Refund intent is retained across a page reload for the edit flow.
- KDS now owns persistent ticket/line state, configurable category station routing and
  configurable SLA, sends bus notifications with a two-second polling fallback, exposes
  order/menu views and served/cancelled history with time/duration, skips refund orders,
  and cancels the source kitchen ticket only after a refund validates. Its Odoo
  lifecycle test passes (`0 failed, 0 errors of 1 tests`). POS and KDS assets compile and
  load with no browser console error; the Thai override signal remains exactly 57 files.
  Repacked root/repo bundles match at SHA-256
  `ee3b072283b97bcd1b49599eecc2c60860357c5e5f77c99d610f9d377db0a68f`.
- Production deploy actions **110883615**, hotfix **110885173**, and KDS watchdog fix
  **110891014** succeeded on
  2026-08-23. Both init containers exited 0; the six addon directories were present;
  `ko_pos_kds` and `ko_pos_ui` loaded; both Odoo processes included
  `/mnt/extra-addons`; translations remained exactly 57 files; `MASTER_PW_LINES=1` and
  HTTP on 8069 were confirmed; no build/runtime error signal remained.
- Authenticated production QA at 1280×720 passed list-first Sell, empty current order,
  category filtering, Thai search, Bills with persisted paid orders, and bottom
  navigation. KDS loaded SLA 15 minutes and ticket data after the 19.0.4.0.1 cache-bust
  hotfix; active/served/cancelled tabs, order/menu views, and station filtering worked
  without a console error. No product was added, sent, paid, refunded, or cancelled, and
  the live session was not closed.
- At the owner's explicit request, the stale KDS-only ticket **K0003 / queue 1003**
  (`ข้าวผัดกุ้ง`, POS reference `261-2-000003`) was deleted from the KDS ticket-history
  list on 2026-08-23. The live KDS then showed `กำลังทำ (0)` and `ไม่มีออเดอร์ค้าง`;
  K0001/K0002 remained in history. No POS sale order was selected or deleted.
- The recurring Odoo “หน้านี้เลิกใช้งานแล้ว” warning on fresh KDS pages was traced to
  the standalone template loading `web.assets_frontend` without initializing
  `odoo.__session_info__`. The asset watchdog therefore compared the bus notification
  against an empty `session.server_version` and raised a false warning. Version
  **19.0.4.0.2** seeds Odoo's standard frontend session info before assets load and bumps
  the direct-script cache key. Static checks and disposable Odoo 19 render/integration QA
  passed. Production action **110891014** installed it successfully: a fresh authenticated
  `/kds` served `kds.js?v=19.0.4.0.2`, kept SLA/ticket polling live, and showed no stale-page
  warning after more than 70 seconds. Served-tab and station-filter checks passed, server
  logs remained error-free, and K0003 was not changed.

- **KDS is scoped per shop (verified live 2026-08-23).** `ko_pos_kds` **19.0.5.0.0** binds
  one kitchen screen to one POS. `/kds` renders a shop picker (and redirects straight
  through when the user can see only one POS); the board is `/kds/pos/<config_id>`;
  `/kds/data` requires `config_id` and returns `400 config_required` without one; the bus
  channel is `ko_pos_kds_<config_id>` on both the screen and the POS client; every
  mutating `/kds/*` route re-checks the ticket's POS against the user's allowed POS list.
  `ko.kds.ticket` and `ko.kds.ticket.line` gained a stored `company_id` (related from the
  POS) with global `ir.rule`s in `security/kds_security.xml`; `ko.kds.station` gained
  `config_ids` / `company_id` so a station can belong to one shop. `ko_pos_ui`
  **19.0.4.1.0** sends the kitchen tab to `/kds/pos/<current config>` instead of `/kds`.
  Old `/kds/<id>` bookmarks now redirect to the picker rather than guessing a shop.
- Verification for that change: five module tests pass on a disposable Odoo 19 + Postgres
  database (`0 failed, 0 error(s) of 5 tests`), and an authenticated HTTP pass on that
  database confirmed each board returned only its own ticket, `400` without `config_id`,
  `303` to `/kds` for a POS outside the user's companies, and `403` on a cross-company
  ticket action. Deploy action **110896245** succeeded; the init log shows
  `DEPLOYED_ko_pos_kds: 'version': '19.0.5.0.0'`, `KDS_SECURITY_PRESENT=yes`, and
  translations still exactly 57 files. Live at `kodoo.viakuma.com` the picker lists
  **ร้านชอบแกง** (config 2) and **ร้านหวานอยู่** (config 3); each board reports its own
  shop name, its own `ko_pos_kds_<id>` channel, and existing tickets K0001/K0002 now carry
  `company_id = บริษัท น็อกเอาต์ จำกัด`. **Not verified live:** two shops with live
  tickets side by side — production had no open kitchen tickets at the time, and no test
  ticket was created in production on purpose.
- **Sell menu is a real list (fixed and verified live 2026-08-23).** `ko_pos_ui`
  **19.0.4.2.0**. Odoo 19 hands every `ProductCard` the Bootstrap utility class from
  `pos.productViewMode` (`flex-column`, or `flex-row-reverse justify-content-between m-1`
  on small screens); those utilities are `!important`, so the KO row styling never took
  effect and each menu item kept stacking image-over-name instead of the one-dish-per-line
  list of `design_handoff_ko_pos_ui` §1. `.ko-product-card` now pins
  `flex-direction: row`, `justify-content: flex-start`, `text-align: left` and `margin: 0`
  with `!important`, keeps `.product-content` / `.product-name` left aligned (Odoo centers
  the no-image variant), hides Odoo's own `.product-cart-qty` badge, and gives the
  orderline stepper 10 px of room so it no longer touches the line price.
  Deploy action **110899755**: `DEPLOYED_ko_pos_ui: "version": "19.0.4.2.0"`,
  `KDS_SECURITY_PRESENT=yes`, translations still exactly 57 files, `ko_pos_ui` loaded.
  Verified live at `kodoo.viakuma.com` (POS 2, ร้านชอบแกง) at 1600 px, 760 px and 420 px:
  rows are 54 px thumbnail + name + `฿price` + `+` / stepper, 81 px tall, contiguous with
  a 1 px `--ko-line` divider, in-cart rows tinted `--ko-primary-soft`.
  **Not verified:** payment, kitchen state and session close were not touched; the English
  subline still cannot be checked because the seed menu has no `public_description`.
- **Order control buttons show their full Thai labels (fixed and verified live 2026-08-23).**
  `ko_pos_ui` **19.0.4.3.0**. Odoo 19 renders the row under the current order
  (`ลูกค้า` / `โน้ต` / the preset `ทานที่ร้าน` / `คอร์ส` / save / `⋮`) as `.text-truncate`
  buttons inside a single non-wrapping `d-flex justify-content-between` row that is sized
  for short English labels. The left pane is a fixed 380 px (363 px of usable row), the six
  buttons needed about 396 px at Odoo's 17.5 px font, so Thai labels were cut to `ลู…` and
  `ทา…`. New file `static/src/app/ko_pos_ui_control_buttons.scss` restyles them as KO pill
  chips (14 px, 40 px tall, `nowrap`, `text-overflow: clip`, `overflow: visible`, `margin`
  reset so Odoo's `ms-auto` cannot stretch the row), lets the row `flex-wrap` when a long
  partner or preset name needs a second line, tints the active preset with
  `--ko-primary-soft`, keeps only a selected partner's name ellipsised at 150 px, and hides
  Odoo's own `.more-btn` — `ko-order-heading` already renders the KO `⋯` button bound to the
  same `displayAllControlPopup` handler, so it was a duplicate that pushed the row over its
  width. Deploy action **110902588**: `DEPLOYED_ko_pos_ui: "version": "19.0.4.3.0"`,
  `KDS_SECURITY_PRESENT=yes`, translations still exactly 57 files, `ko_pos_ui` loaded.
  Verified live at `kodoo.viakuma.com` (POS 2, ร้านชอบแกง, table 1) after a hard refresh:
  all five buttons fit one 50 px row with rendered width ≥ scroll width (no truncation), the
  KO `⋯` still opens the full `การดำเนินการ` popup, and the row wraps instead of clipping
  when a 40-character partner name is injected. The QA draft line added for the check was
  removed; nothing was sent to the kitchen, paid, or closed.
- **After any `ko_pos_ui` deploy, every browser that already had the POS open keeps the old
  assets** until a hard refresh: the POS service workers cache `odoo-sw-cache` /
  `odoo-pos-cache` and the stylesheet URL has no version segment. See `docs/GOTCHAS.md`.

---

- **Beam Bolt Pairing Mode and shared-device support are deployed in production as
  `ko_pos_beam_bolt` 19.0.3.0.0.**
  The payment-method form can create, inspect, and
  delete a Bolt Connection from the Pairing code shown by the device or Android app and stores both the
  Connection ID and Device ID. Bolt Intent requests match Beam API v1.22.0, including all
  ten supported payment methods, the 90–600 second expiry limit, method-specific child
  objects, `PATCH` cancellation, and `x-beam-idempotency-key` on every POST/PATCH. POS
  persists an uncertain create key and reuses it on Retry/Cancel so a timeout does not
  silently create a second charge. Python/JS/XML static checks and mocked backend/POS
  success, decline, cancel, rate-limit, and timeout-retry flows pass. Hotfix `19.0.2.0.1`
  removes the incorrect six-digit/numeric restriction: Beam OpenAPI v1.22.0 defines
  `pairingCode` only as a string, and current Android builds can display eight characters.
  Only a non-empty code is required; its trimmed value is passed unchanged to Beam.
  Local Odoo 19 tests and GitHub Actions run `32834736387` passed with
  `0 failed, 0 error(s) of 8 tests` at commit `b65f09c`. Production deploy action
  **111200985** installed that `main` HEAD on 2026-08-25. The init log proves
  `DEPLOYED_ko_pos_beam_bolt: 'version': '19.0.2.0.1'`; upgrade and runtime each loaded
  90 modules, Beam loaded cleanly as module 73/90, Thai overrides remained exactly 57
  files, both one-shot services exited 0, Postgres is healthy, Odoo is running on 8069,
  and authenticated browser QA opened the live company with no console warning/error.
  Live form inspection after the 19.0.3.0.0 deploy found that the historical prepared
  records id 8/id 9 no longer exist. The current connection owner is payment method id 5,
  `บัตรเครดิต`, using journal `ธนาคาร`, assigned to both POS shops. It is configured for
  Production, reports `เชื่อมต่อแล้ว`, and retained its Bolt Connection ID and Device ID
  across the module upgrade. No Pair, Disconnect, or payment transaction was sent during
  agent QA.
  Live form inspection also confirmed Odoo's two-step selector: choose `เครื่องรูดบัตร`
  under `การผสานรวม` first, then choose `Beam Bolt+` in the revealed `ผสานรวมกับ` field.

- **Permanent shared-device support is deployed and verified structurally in production.**
  `ko_pos_beam_bolt` **19.0.3.0.0** at commit `dca241e` adds an owner/dependent model:
  pair one payment method once, then select it in `ใช้การเชื่อมต่อ Beam จาก` on Card,
  QR PromptPay, or another Beam method. Every dependent sends its own Beam payment type
  while reusing the owner's Connection ID, Device ID, environment, and credentials.
  Chained sharing, cross-company sharing, re-pairing a dependent, and disconnecting an
  owner while dependents still use it are blocked. Local Odoo 19 tests and GitHub Actions
  run `32837879611` passed with `0 failed, 0 error(s) of 12 tests`. Production action
  **111210069** succeeded on 2026-08-25: `addons-init` and `odoo-upgrade` exited 0,
  Postgres is healthy, Odoo is running on 8069, the clone reported
  `DEPLOYED_ko_pos_beam_bolt: 'version': '19.0.3.0.0'`, upgrade and runtime each loaded
  90 modules, Beam loaded cleanly as module 73/90, Thai overrides remained exactly 57
  files, and `MASTER_PW_LINES=1`. Authenticated live form QA confirmed the new
  `ใช้การเชื่อมต่อ Beam จาก` field and the preserved connected owner id 5. Not verified:
  no dependent PromptPay method was created and no live payment was submitted.

---

## 9. Outstanding work

1. **Finish data-backed §1 QA:** once real menu data has an English
   `public_description` and a configurable item, verify English search and Odoo's
   configurator path live.
2. **Production phone-width spot check:** final §2–§9 production QA used the fixed
   1280×720 browser surface. Local 390×844 and the earlier §1 live phone checks passed,
   but repeat the final production flow at 390 px when a resizable live browser is
   available; do not complete payment or change kitchen state.
3. **Real business data from the owner:** real PromptPay number (currently the placeholder
   `0812345678`), the real menu items & prices, and the kitchen printer's IP (Epson).
4. **Beam Bolt+ shared-device transaction QA:** create the required QR PromptPay dependent
   by selecting connected owner id 5 (`บัตรเครดิต`) in `ใช้การเชื่อมต่อ Beam จาก`; do not
   Pair again. Confirm the intended POS assignments, then run the supervised Card and
   PromptPay scenarios in `docs/RUNBOOK-beam-bolt.md`. Production currently uses a live
   Production connection, so every payment test must be explicitly coordinated.
5. **Staff training:** POS at `/pos/ui`, kitchen display at `/kds`, and the end-of-day
   session close.
6. **Optional:** drop the unused `ko_pos` and `kodoo` databases once confirmed.

> ✅ Completed 2026-08-23: stopped the order control buttons truncating their Thai labels
> (`ko_pos_ui` 19.0.4.3.0) by restyling Odoo's `.control-buttons` row as wrapping KO chips
> and hiding its duplicate `⋮`. Deploy action `110902588`; verified live after a hard refresh.
>
> ✅ Completed 2026-08-23: made the Sell menu render one row per dish (`ko_pos_ui`
> 19.0.4.2.0) by overriding Odoo 19's Bootstrap `flex-column` product-card utility.
> Deploy action `110899755`; verified live after clearing the POS service-worker cache.
>
> ✅ Completed 2026-08-23: scoped the kitchen display per shop (`ko_pos_kds` 19.0.5.0.0,
> `ko_pos_ui` 19.0.4.1.0) and flipped `addons-init` to deploy the repo's `addons/`
> directory instead of `addons.tar.gz`. Deploy action `110896245`.
>
> ✅ Completed 2026-08-23: deleted stale KDS-only ticket K0003 / queue 1003 after the
> owner explicitly requested it. Live KDS verified empty; K0001/K0002 and POS sales were
> left untouched.

> ✅ Completed 2026-08-23: fixed the recurring false KDS stale-page warning in
> `ko_pos_kds` 19.0.4.0.2 by initializing Odoo frontend session info before frontend
> assets. Deploy action `110891014` passed, including the delayed live watchdog check.

> ✅ Completed 2026-08-23: audited and replaced the incomplete §2–§9 implementation from
> `ffeb880`, completed disposable-database QA, deployed it, and passed production
> safe-path QA. KDS direct-script caching found live was fixed in 19.0.4.0.1.
>
> ✅ Completed 2026-08-23: the patch-pipeline refactor. `patch/thai_v2`, `patch/thai_v3`,
> and the inline base64 `ko_pos_setup` overlay that was embedded in the Compose file are
> all folded into `addons.tar.gz` (verified: 57 i18n_overrides `.po` files, kds_views.xml
> present, extraction matches the production tree). The deploy Compose is now
> `vps-compose-git.yaml` in `deploy-secrets.zip`; it clones `main` and unpacks the one
> tarball. Commit `8ef77ca`, deployed by action `110885173`.
>
> ✅ Completed 2026-08-23: Company name, address, and 13-digit tax ID configured (`บริษัท น็อกเอาต์ จำกัด`).
>
> ✅ Completed 2026-08-22: the `การ์ด` → `บัตรเครดิต` payment-method rename. Odoo blocks
> payment-method writes while any POS session is not `closed`, and it offers **no UI to
> cancel or delete a session** — the Action menu exposes only Export. The only route is
> to open the session and close it normally. See `docs/GOTCHAS.md`.

## 10. Where things live

The owner's local project folder (`KO-DOO`, synced via OneDrive) holds the secrets and
build artefacts that are deliberately kept out of the repo. The `.md` docs exist in
**both** places and must be updated in both — see §0.

| File | Contents |
| --- | --- |
| `CREDENTIALS.local.md` | Passwords and IDs. **Local only — never commit.** |
| `deploy-secrets.zip` | Working Compose files incl. the SSH deploy key |
| `ko-pos-full.zip` | Full addon source + translation tooling |
| `addons.tar.gz` | The deployable addon bundle (same file as the repo's root) |
