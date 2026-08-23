# Runbook — Deploying KO POS

Prerequisite: read `../AGENTS.md` first, especially §0 *Definition of done* and
§7 *Do not break these*.

## What a deploy actually does

There is no incremental deploy. `VPS_createNewProjectV1` with an existing
`project_name` **replaces the entire Compose project**. Containers are recreated;
named volumes (`db`, `odoo-data`) survive, so no data is lost. `/mnt/extra-addons`
is deliberately wiped and rebuilt by cloning `main` and unpacking its `addons.tar.gz`.

## Procedure

### 1. Land your change in the repo first

Nothing on the VPS is a source of truth. Repack `addons.tar.gz`, commit the reviewable
source with it, and push `main` before deploying. The deploy key is read-only, so the VPS
always clones exactly the remote `main`; an unpushed change cannot reach production.

### 2. Call the deploy API

Tool: `VPS_createNewProjectV1`

| Parameter | Value |
| --- | --- |
| `virtualMachineId` | `973354` |
| `project_name` | `odoo-5qm8` |
| `environment` | **required every time** — see below |
| `content` | full YAML of the Compose file |

`environment` must contain both lines (values in `../CREDENTIALS.local.md`, local only):

```
DB_PASSWORD=<value>
TRAEFIK_HOST=srv973354.hstgr.cloud
```

> Omitting `environment` does not error. It replaces the project with an empty env,
> Postgres comes up with a different password than Odoo expects, and the stack fails
> in a way that looks like a database problem. Always pass it.

The Compose YAML to send is `deploy_real/vps-compose-git.yaml` inside
`deploy-secrets.zip`. It is deliberately below Hostinger's 8,192-character `content`
limit, embeds the read-only SSH deploy key, clones `main`, unpacks `addons.tar.gz`, and
does no patching. Never send `vps-compose-simplified.yaml`: its inline tar makes it about
690 KB and Hostinger rejects the request before deployment. `vps-compose-thaiv2.yaml`
and the other files are historical only.

Before sending it, verify three invariants introduced after the 2026-08-22 Odoo image
refresh:

1. Both `odoo` and `odoo-upgrade` commands pass an explicit `--addons-path` ending in
   `/mnt/extra-addons`.
2. `addons-init` finishes with `chmod -R a+rX /mnt/extra-addons`.
3. Both install/update module lists include `ko_pos_ui`.
4. The Compose is no more than 8,192 characters and contains no `patch/thai` handling.

### 3. Poll until the action finishes

`VPS_getActionDetailsV1` with `virtualMachineId: 973354` and the `id` returned by the
deploy call. Wait for `state: "success"` (typically 40–60 s). `state: "sent"` or
`"started"` means keep waiting.

Action success is not proof that Compose succeeded. Hostinger has returned success for
an operation whose `odoo-upgrade` service exited 1; Step 4 remains mandatory.

### 4. Read the logs — this is the part people skip

`VPS_getProjectLogsV1` with `projectName: odoo-5qm8`.

> "Project deployed successfully" only means the containers started. It says nothing
> about whether your change took effect.

Check, in order:

1. **Build log — shell variable interpolation.** Search for `variable is not set`.
   Any hit means Docker Compose ate a `$VAR` in a `command:` block and replaced it with
   an empty string. Your shell logic silently did nothing. Fix by doubling the dollar
   sign (`$$VAR`) and redeploy. See `GOTCHAS.md`.

2. **`addons-init` service.** It clones `main` and unpacks the tarball. Expect:
   ```
   addons ready:
   ko_pos_beam_bolt
   ko_pos_kds
   ko_pos_setup
   ko_pos_thai_lang
   ko_pos_thai_receipt
   ko_pos_ui
   ```
   (Since the 2026-08-23 refactor the patch pipeline is gone — `addons-init` only
   clones, unpacks `addons.tar.gz`, and chmods. If you ever reintroduce shell logic
   here, remember the `$$VAR` rule from check 1.)

3. **`odoo-upgrade` service.** The line that proves translations landed:
   ```
   ko_pos_thai_lang: applied Thai override translations from 57 files
   ```
   Then `Modules loaded.` and a clean `Initiating shutdown` (this container is
   `--stop-after-init`; exiting is success, not failure).

   Its startup line must list `/mnt/extra-addons` in `addons paths`. For the UI addon,
   also require `Loading module ko_pos_ui` followed by `Module ko_pos_ui loaded`. Any
   `manifest not found`, `invalid module names`, or `PermissionError` means the deploy
   did not install the custom modules even if the Hostinger action says success.

4. **`odoo` service.** Its startup line must also list `/mnt/extra-addons`, followed by
   `HTTP service (werkzeug) running on …:8069` and `MASTER_PW_LINES=1`.

### 5. Verify in the running app

The agent sandbox cannot reach `kodoo.viakuma.com` (egress blocked). Use browser
tooling. The cheapest high-signal check is to ask Odoo what a label resolves to,
via an authenticated session in the browser:

```js
// read-only: what does account.move.state look like in Thai now?
await fetch('/web/dataset/call_kw', {
  method: 'POST', headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({jsonrpc: "2.0", method: "call", params: {
    model: "account.move", method: "fields_get",
    args: [["state"], ["selection", "string"]],
    kwargs: {context: {lang: "th_TH"}}
  }})
}).then(r => r.json());
```

To sweep for a suspect word across every field label:

```js
// find field labels still containing a bad word
model: "ir.model.fields", method: "search_read",
args: [[["field_description", "like", "รัฐ"]], ["model", "name", "field_description"]],
kwargs: {context: {lang: "th_TH"}, limit: 100}
```

Writes through this channel may be blocked by the agent's safety layer, and that is
fine — do record edits through the normal Odoo UI instead.

### 6. Update the docs

Required, not optional. See `../AGENTS.md` §0.

## Rollback

There is no snapshot-based rollback wired up. To revert, `git revert` the repo change
and redeploy. Because `/mnt/extra-addons` is rebuilt from the repo every time, a revert
plus redeploy fully restores the previous addon state. Database rows changed by a
module update are **not** reverted this way.
