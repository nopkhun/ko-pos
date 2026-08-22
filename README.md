# KO POS

Odoo 19 restaurant point-of-sale for a Thai restaurant, running in production at
https://kodoo.viakuma.com

**If you are an AI agent (or a human) picking this up: read [AGENTS.md](./AGENTS.md) first.**
It is the canonical brief — architecture, deploy procedure, the Thai translation layer,
and the traps that have already cost time on this project.

| Doc | What it covers |
| --- | --- |
| [AGENTS.md](./AGENTS.md) | Start here. Whole-project brief. |
| [docs/RUNBOOK-deploy.md](./docs/RUNBOOK-deploy.md) | How to deploy and how to verify it actually worked |
| [docs/RUNBOOK-translations.md](./docs/RUNBOOK-translations.md) | How to change a Thai word, end to end |
| [docs/GOTCHAS.md](./docs/GOTCHAS.md) | Symptom-first list of every trap hit so far |

Credentials are deliberately **not** in this repo. They live in `CREDENTIALS.local.md`
in the owner's local project folder, alongside `deploy-secrets.zip` which holds the
Docker Compose file (it embeds the SSH deploy key).
