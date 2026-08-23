# Runbook — Changing a Thai word

Read `../AGENTS.md` §5 first. It explains why the mechanism looks the way it does.

## Step 0 — Decide which kind of string you are looking at

This is the most common mistake on this project.

```
Is the text a LABEL that Odoo ships in English and translates?
  → field label, selection value, menu, button, POS screen text, error message
  → fix it in a .po file.  Go to Step 1.

Is the text the NAME OF A RECORD someone created?
  → a payment method, a product, a POS category, a floor, a journal
  → no .po change will ever touch it. Edit the record in the Odoo UI.
```

Quick test — ask the database whether the record has an XML ID:

```js
model: "ir.model.data", method: "search_read",
args: [[["model", "=", "pos.payment.method"]], ["module", "name", "res_id"]]
```

An empty result means the record was created at runtime (by a setup wizard or a user).
It is data. Rename it in the UI.

## Step 1 — Find the exact msgid and the module

`i18n_overrides/<module>.po` overrides module `<module>`. You need to know which
module owns the string, and its exact English source text.

For a field label, get the field's XML ID — that tells you both:

```js
// 1. find the field
model: "ir.model.fields", method: "search_read",
args: [[["model", "=", "account.payment"], ["name", "=", "state"]], ["model", "name"]]

// 2. find its XML ID → "account.field_account_payment__state"
model: "ir.model.data", method: "search_read",
args: [[["model", "=", "ir.model.fields"], ["res_id", "in", [<id>]]], ["module", "name"]]
```

The prefix before the dot (`account`) is the module → edit `account.po`.

## Step 2 — Write the entry

Model-term entries are keyed by the `#:` reference comment, not just the msgid:

```po
#. module: account
#: model:ir.model.fields,field_description:account.field_account_payment__state
msgid "State"
msgstr "สถานะ"
```

If the same English string applies to several records, use **one entry with several
`#:` lines** — never two entries with the same `msgid` in one file, which is a
duplicate and may be rejected:

```po
#. module: account
#: model:ir.model.fields,field_description:account.field_account_payment__state
#: model:ir.model.fields,field_description:account.field_account_lock_exception__state
msgid "State"
msgstr "สถานะ"
```

Code strings (POS screens, Python messages) use a `code:` reference instead:

```po
#. module: point_of_sale
#. odoo-python
#: code:addons/point_of_sale/models/pos_config.py:0
msgid "Card"
msgstr "บัตรเครดิต"
```

## Step 3 — Validate before shipping

Always parse the edited files. A malformed `.po` will not necessarily crash the
deploy — it may just silently drop entries.

```bash
pip install polib --break-system-packages -q
python3 - <<'EOF'
import polib, glob, os
for f in sorted(glob.glob('i18n_overrides/*.po')):
    po = polib.pofile(f)                      # raises on malformed input
    ids = [e.msgid for e in po]
    dups = {i for i in ids if ids.count(i) > 1}
    if dups:
        print("DUPLICATE msgid in", os.path.basename(f), list(dups)[:5])
print("ok")
EOF
```

## Step 4 — Get it into the repo

**The patch pipeline (`patch/thai_v2/`, `patch/thai_v3/`) was retired on 2026-08-23.**
Everything it delivered is folded into `addons.tar.gz`, which is now the single
source of truth. The section below is kept for historical reference only.

### If you have a real clone (Codex, Antigravity, local shell) — do it this way

Unpack `addons.tar.gz`, edit `ko_pos_thai_lang/i18n_overrides/<module>.po` directly,
repack, commit:

```bash
mkdir /tmp/ko && tar xzf addons.tar.gz -C /tmp/ko
# edit files under /tmp/ko/...
cd /tmp/ko && COPYFILE_DISABLE=1 tar czf <repo>/addons.tar.gz .
```

### Historical: chat-only agent with a text-only push tool (pipeline retired 2026-08-23)

**Small text file → just push it.** `.po` fragments are plain UTF-8. Put them in
`patch/thai_v3/<module>.append.po`; `addons-init` appends them onto the matching
`.po` at deploy time. This is how the `State` → `สถานะ` fix shipped. Only safe when
the msgid does not already exist in the target file — check first, or you create a
duplicate.

**Binary or bulk change → the base64 pipeline.** This is genuinely painful; budget for it.

```bash
tar czf patch.tar.gz <files>
base64 patch.tar.gz > patch.b64
split -n 8 patch.b64 chunk_        # ~3.6 KB pieces are the reliable size
for f in chunk_*; do git hash-object "$f"; done   # record every SHA
```

Push each piece as `patch/thai_v2/pNN.b64`, then **verify every one**: list the
directory with the GitHub file-contents tool, which returns each blob's SHA, and
compare against your local `git hash-object` values.

Hard-won rules:

- **Transcription through a chat context is lossy.** At 28 KB per piece, 4 of 8 pieces
  were corrupted. At ~3.6 KB, most survive. Verify all of them, every time.
- **Never re-transcribe a piece that already verified.** Re-`cat` the file immediately
  before each push; never copy from earlier in the conversation.
- **A failed piece gets split further**, to ~900 B, and re-pushed. Far cheaper than
  resending the whole bundle.
- **Base64 ignores newlines**, so a piece differing only by a trailing newline is fine.
  Confirm with `git hash-object` on the content minus the newline before dismissing it.
- **You cannot delete files** with the GitHub MCP tool, but pushing `content: ""` makes
  a file empty, and an empty file contributes nothing to `cat`. That is how a corrupt
  `p03d.b64` was retired in favour of `p03d1..4.b64`.
- **Glob order must be byte order.** The reassembly uses
  `ls patch/thai_v2/*.b64 | LC_ALL=C sort | xargs cat | tr -d '\n' | base64 -d | tar xz`.
  ASCII ordering gives `p03d.b64` < `p03d1.b64` < `p03e.b64`, which is what makes the
  empty-placeholder trick work.

Prove the round trip locally before deploying:

```bash
cat $(ls patch/thai_v2/*.b64 | LC_ALL=C sort) | tr -d '\n' | base64 -d > rebuilt.tar.gz
md5sum rebuilt.tar.gz patch.tar.gz     # must match
```

## Step 5 — Deploy, verify, and update the docs

Follow `RUNBOOK-deploy.md`. The check that matters:

```
ko_pos_thai_lang: applied Thai override translations from 57 files
```

Then confirm the specific string changed in the live app. A deploy that reports success
while the file count is wrong has silently under-delivered.

Finally, record the new vocabulary decision in `../AGENTS.md` §5 and update §8/§9 —
see §0. A wording choice that is not written down gets reverted by the next agent.
