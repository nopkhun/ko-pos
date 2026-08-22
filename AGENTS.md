# KO POS — Agent Handoff / คู่มือส่งต่องานสำหรับ AI

> **Read this file first.** It is the canonical brief for any AI agent (Claude, Codex,
> ChatGPT, Gemini, Antigravity, Cursor, …) picking up this project. Everything here was
> verified against the running production system, not inferred.
>
> **สรุปภาษาไทย:** โปรเจคนี้คือระบบ POS ร้านอาหาร (Odoo 19) รันจริงบน Hostinger VPS ที่
> https://kodoo.viakuma.com — ใช้งานจริงแล้ว มี addon ของเราเอง 5 ตัว และระบบคำแปลไทย
> "ฉบับร้านอาหาร" ที่เขียนเอง อ่านหัวข้อ *Do not break these* ก่อนแก้อะไรทั้งสิ้น

- **Last verified:** 2026-08-23
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
  └─ clones the git repo with an embedded SSH deploy key
  └─ wipes /mnt/extra-addons, unpacks addons.tar.gz
  └─ decodes patch/thai_v2/*.b64  → overwrites i18n_overrides/
  └─ appends patch/thai_v3/*.append.po onto the matching .po files
  └─ makes /mnt/extra-addons readable by the non-root Odoo user
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
Never hand-edit files inside that volume expecting them to survive — put changes in the repo.

---

## 3. The six custom addons

All live in `addons.tar.gz` at the repo root.

| Module | Purpose |
| --- | --- |
| `ko_pos_setup` | Restaurant seed data: POS categories, floors/tables, demo products |
| `ko_pos_thai_receipt` | Thai abbreviated tax invoice (ใบกำกับภาษีอย่างย่อ) receipt layout |
| `ko_pos_kds` | Kitchen Display System (jaw-krua / จอครัว) at `/kds` |
| `ko_pos_beam_bolt` | Beam Bolt+ card-terminal payment integration (not yet configured with a live merchant key) |
| `ko_pos_thai_lang` | The Thai translation override layer — see §5. Depends on all four above. |
| `ko_pos_ui` | Touch-first restaurant POS interface: clearer menu/category grid, current-order panel, prices, payment emphasis, responsive tablet/mobile layout. Presentation only; it does not change order, tax, or payment logic. |

---

## 4. Repository layout (`nopkhun/ko-pos`, branch `main`)

```
addons.tar.gz              ← THE deployment source of truth (all 6 modules)
addons/                    ← ⚠️ NOT read by deployment. Contains a partial copy of
                              ko_pos_thai_lang and a reviewable source copy of ko_pos_ui.
                              The deploy script prefers addons.tar.gz and never reads this.
                              Do not "fix" a bug by editing addons/ — it has no effect.
patch/thai_v2/*.b64        ← gzip+base64 chunks of a tarball that overwrites
                              ko_pos_thai_lang/i18n_overrides/ and ko_pos_kds/views/kds_views.xml
patch/thai_v3/*.append.po  ← small plain-text .po fragments appended onto existing .po files
AGENTS.md                  ← this file
docs/                      ← runbooks, see below
```

### Why the `patch/` directories exist

The only write path into this repo from the agent session is a GitHub MCP tool that
accepts **text content inline only** — it cannot upload binary. So `addons.tar.gz`
cannot be regenerated from a chat session. `patch/thai_v2/` is a workaround: the
tarball of changed files, gzipped, base64'd, split into ~3.6 KB pieces, each verified
by git blob SHA. The deploy script reassembles it. Full mechanics in
`docs/RUNBOOK-translations.md`.

**If you have real filesystem + git access** (Codex, Antigravity, a local clone), you do
not need any of that. Prefer to: unpack `addons.tar.gz`, edit the modules properly,
repack, commit, and then **delete `patch/thai_v2/` and `patch/thai_v3/` and remove
their handling from the Compose file** so the pipeline has one obvious source of truth.
That cleanup is the single highest-value refactor available on this project.

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
2. **Never commit the SSH deploy key or the Compose file that embeds it.** The working
   Compose lives locally in `deploy-secrets.zip` (`deploy_real/vps-compose-thaiv2.yaml`).
   The repo must never contain it.
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
9. **Keep `/mnt/extra-addons` explicit and readable.** Both Odoo commands must pass an
   `--addons-path` that includes `/mnt/extra-addons`, and `addons-init` must finish with
   `chmod -R a+rX /mnt/extra-addons`. The `odoo:19` image pulled on 2026-08-22 did not
   include the mounted path automatically; see `docs/GOTCHAS.md`.

---

## 8. Current state (verified 2026-08-23)

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
- Production Compose now passes `/mnt/extra-addons` explicitly to both Odoo processes
  and makes the mounted addon tree readable. Final deploy action `110739168` completed;
  Postgres is healthy, Odoo is running, both init services exited 0, and the Thai override
  success signal remains exactly 57 files.

---

## 9. Outstanding work

1. **Real business data from the owner:** shop name, address, 13-digit tax ID, real
   PromptPay number (currently the placeholder `0812345678`), the real menu, and the
   kitchen printer's IP (Epson).
2. **Beam Bolt+:** register a merchant account, obtain the API key, pair the terminal,
   attach it to the payment method, and test against the Beam playground before live use.
3. **Staff training:** POS at `/pos/ui`, kitchen display at `/kds`, and the end-of-day
   session close.
4. **Refactor (recommended):** fold `patch/thai_v2` + `patch/thai_v3` back into
   `addons.tar.gz`, delete the patch directories, and simplify `addons-init`. See §4.
5. **Optional:** drop the unused `ko_pos` and `kodoo` databases once confirmed.

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
