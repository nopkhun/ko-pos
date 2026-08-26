# Runbook — MCP Server (ให้ AI คุยกับ Odoo)

`addons/mcp_server` — **MCP Server 19.0.2.0.0**, much. Consulting, OPL-1 (paid, bought from
the Odoo Apps store). It publishes an MCP endpoint at `POST /mcp` so MCP clients (Claude,
Cursor, VS Code, MCP Inspector) can search, read and — if you allow it — write Odoo records.
Installed on production 2026-08-26.

## How it is deployed

- It sits in `addons/` like our own modules; `addons-init` copies it in on every deploy and
  logs `DEPLOYED_mcp_server:`.
- **Never install it through ตั้งค่า → นำเข้าโมดูล.** That route cannot install a module with
  Python models and fails on `model_mcp_enabled_model` — see `GOTCHAS.md`.
- It needs `authlib`, `defusedxml`, `packaging`, none of which ship in the `odoo:19` image.
  The `pydeps-init` service installs them into `/var/lib/odoo/pylibs` (a persistent volume)
  and both Odoo services read them through `PYTHONPATH`. Any Compose you deploy **must**
  keep that, or Odoo refuses to start.
- Upgrading = download the new zip from the store, replace `addons/mcp_server` wholesale,
  push, deploy, then อัพเกรด from แอป. Do not hand-edit the module.

## Turning it on (nothing is exposed until you do)

1. **Master switch** — ตั้งค่า → การตั้งค่าทั่วไป → *MCP Server Configuration* →
   **Enable MCP Access**.
2. **Choose the models** — ตั้งค่า → MCP Server → *Enabled Models*. Add one line per model
   and tick read / write / create / delete individually. An unlisted model is invisible to
   every client, and read-only is the safe default; POS and accounting models should stay
   read-only unless there is a reason.
3. **API key** — โปรไฟล์ของฉัน → *Account Security* → New API Key, scope **MCP only** (that
   key authenticates on `/mcp` and nowhere else). Copy it once; Odoo will not show it again.
4. **Client** — point the client at `https://kodoo.viakuma.com/mcp` with
   `Authorization: Bearer <key>`. Browser clients (Claude.ai, Gemini) can instead log in with
   OAuth and may withhold the *Allow creating and modifying data* checkbox for a read-only
   session.

## What is actually configured on production (2026-08-26)

Master switch **on** (`mcp_server.enabled=True`), OAuth **on**, request logging **on**,
rate limiting **off** (a 300/min limit is configured but not enforced — turn it on in
General Settings if a client ever runs away). OAuth discovery answers at
`/.well-known/oauth-authorization-server` with dynamic client registration and the scopes
`mcp`, `mcp:read`, `mcp:write`, so a client can connect by logging into Odoo — no key to
copy around.

Enabled models (`ตั้งค่า → MCP Server → Enabled Models`), 15 rows:

| Models | Allowed |
| --- | --- |
| `product.template`, `product.product`, `product.category`, `pos.category`, `hr.employee`, `res.partner` | read + create + write + **delete** |
| `hr.job`, `hr.department` | read + create + write |
| `pos.order`, `pos.order.line`, `pos.session`, `pos.config`, `pos.payment`, `pos.payment.method`, `uom.uom` | **read only** |

`allow_method_calls` is off on every row. Sales history is deliberately read-only: an AI can
report on it but cannot rewrite a bill. Menu, staff and contacts are fully writable because
that is the point — and because everything an MCP client does is capped by the Odoo user
whose credentials it used.

## Connecting a client

Each client authenticates as an Odoo **user**; every write shows up under that user in the
chatter and in MCP Logs. Use a dedicated user (e.g. *AI Assistant*) rather than `admin`, so
the audit trail separates AI edits from yours and the groups can be trimmed later.

| Client | How |
| --- | --- |
| **Claude Code** | `claude mcp add --transport http odoo https://kodoo.viakuma.com/mcp` then `/mcp` in a session → *Authenticate* (OAuth browser login). For an API key instead: append `--header "Authorization: Bearer <key>"` |
| **Claude app / Cowork** | Settings → Connectors → *Add custom connector* → URL `https://kodoo.viakuma.com/mcp` → connect and log in |
| **ChatGPT Codex** | `~/.codex/config.toml`: `experimental_use_rmcp_client = true` at top level, then `[mcp_servers.odoo]` with `url = "https://kodoo.viakuma.com/mcp"` and `bearer_token = "<key>"` (needs an API key — Codex does not do the OAuth dance) |
| **Hermes** | Ask Hermes itself to add the MCP server; it has a `setup_mcp` tool with a consent card. Its own prompt says **never hand-edit `mcp_servers`** in `~/.hermes/config.yaml` |

An API key is minted by the user it belongs to: log in as that user → โปรไฟล์ของฉัน →
*Account Security* → New API Key → scope **MCP only**. Odoo shows it once. An agent must not
create Odoo users or type passwords — that part is always the owner's to do.

## Checking it after a deploy

| What | Where |
| --- | --- |
| module landed | `addons-init` log: `DEPLOYED_mcp_server: "version": "19.0.2.0.0"` |
| python deps landed | `pydeps-init` log: `PYDEPS_IMPORT_OK 1.6.12` |
| module installed | แอป → ค้นหา *โมดูล* `mcp` (clear the แอป filter — it is not an Application) |
| endpoint answers | call `POST /mcp` with the API key; an unauthenticated call must be rejected |

## Care

- Every enabled model is readable by anyone holding a key — treat a key like the admin
  password, and revoke it in *Account Security* the moment it is not needed.
- `mcp.log` records requests; check it there first when a client behaves oddly.
- The endpoint is public on `kodoo.viakuma.com`. Keep the master switch off whenever no
  client is actually using it.
