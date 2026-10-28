# Cursor coding agent on Render Sandboxes

A one-shot coding agent: send it a prompt, and a Cursor Cloud Agent runs the
agent loop while an `agent worker` in an ephemeral Render Sandbox runs its
commands and file edits. Files the agent writes to `/workspace/output` are
copied back to your machine.

> Render Sandboxes is in early access. Cursor Self-Hosted Machines and Team
> Pools require Cursor Enterprise and team-admin enablement.

Follow the tutorial:
[Run Cursor Cloud Agents on Render Sandboxes](https://render.com/docs/sandboxes/hosted-agents/cursor).

## Quickstart

You need Node.js 22+, a Render workspace with Sandboxes enabled, a Cursor
service-account API key with agent scope, and an existing named
any-repository Team Pool.

```bash
npm ci
cp .env.example .env   # fill in your credentials
npm run agent -- "Create a hello world HTTP server in /workspace/output. Test it before you finish."
```

Options:

```text
--timeout <seconds>  Override the 600-second deadline
--output <path>      Copy /workspace/output files to this local directory
```

Each run writes `run.json`, `events.jsonl`, and `result.txt` under
`runs/<run_id>/`. The runner deletes only its per-run Cloud Agent, claim, and
sandbox. It never deletes the shared Team Pool.

## Verified versions

- `@renderinc/sdk` 1.3.0
- Cursor Agent CLI `2026.10.19-6bbf2c4` for Linux x64 and arm64, checked
  against a pinned SHA-256

## Development

```bash
npm run check   # typecheck and tests
```
