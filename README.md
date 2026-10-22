# Cursor coding agent on Render Sandboxes

Build a one-shot coding agent that accepts a prompt, uses Cursor Cloud Agents
for the agent loop, and executes commands on a Team Pool worker in an isolated
Render Sandbox.

> Render Sandboxes is early access. Cursor Self-Hosted Machines and Team Pools
> require Cursor Enterprise and team-admin enablement.

See the complete [tutorial](docs/tutorial.md).

## Quickstart

Requires Node.js 20+, a Render workspace with Sandboxes enabled, a Cursor
service-account API key with agent scope, and an existing named
**any-repository** Team Pool.

```bash
npm ci
cp .env.example .env
npm run agent -- \
  "Create a hello world HTTP server in /workspace/output. Test it before you finish."
```

Options:

```text
--timeout <seconds> Override the 10-minute deadline
--output <path>     Copy /workspace/output files to this local path
```

The runner validates the pool, creates one Cloud Agent and its initial run,
claims that agent's pending request with a stable worker ID and a single-claim
token, starts a foreground `agent worker` exec in Render, follows Cursor's
native run SSE stream, downloads regular output files, then tears down all
per-run resources. It never deletes the Team Pool.

## Security and current compatibility seam

- `CURSOR_API_KEY` remains in this Node process. Only Cursor's single-claim
  token enters the sandbox, as a mode-`0600` file.
- `@renderinc/sdk` 1.3.0's hostname `allow-list` admits only the documented
  Cursor worker, artifact, and CLI installation destinations.
- The public SDK has no Sandbox credential-broker primitive. The token is
  therefore materialized and is readable by code running as the sandbox user.
  `src/launch-policy.ts` isolates this behavior for replacement when a brokered
  file API is public.
- Cursor documents the moving `https://cursor.com/install` endpoint, not an
  exact-version selector or artifact checksums. The install script pins the
  reviewed official installer SHA-256 and verifies the installed
  `2026.10.19-6bbf2c4` version. It fails closed when Cursor updates the
  installer.

Run state is atomically written with mode `0600` under `runs/<run_id>/`.
Credentials are excluded and known credential values are redacted from events,
logs, results, and downloaded artifacts.

## Development

```bash
npm run typecheck
npm test
npm run check
```

Unit and fake tests cover atomic state, native SSE handling and fallback,
output copying, redaction, claim-token injection, lifecycle ordering, and
cleanup.
