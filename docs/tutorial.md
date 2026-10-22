# Build a coding agent with Cursor Cloud Agents and Render Sandboxes

In this tutorial, you build a coding agent that accepts a prompt, streams its
work, and returns its response and output files.

Cursor hosts the Cloud Agent loop, inference, planning, and conversation.
`agent worker` runs the coding agent's commands and file edits in an isolated
Render Sandbox in your Render workspace.

You will learn how to:

- route a Cursor Cloud Agent to a Team Pool worker in a Render Sandbox;
- send a coding task as a prompt and follow native run events;
- copy files the agent writes to `/workspace/output`; and
- clean up the Cloud Agent, claim, and sandbox while retaining the Team Pool.

Time to complete: about 20 minutes after access is enabled.

> Render Sandboxes is early access. Cursor Self-Hosted Machines and Team Pools
> are Cursor Enterprise features and must be enabled by a team administrator.

## Prerequisites

You need:

- A Render workspace with Render Sandboxes enabled
- A Render API key and workspace ID
- Cursor Enterprise with Self-Hosted Machines enabled
- A Cursor team service-account API key with agent scope
- An existing any-repository Team Pool
- Node.js 20 or later and Git

The Team Pool is shared configuration. This template does not delete it.
It must be a named any-repository pool; the runner rejects a missing or
repository-backed pool before creating an agent.

## Get the template

```bash
git clone --branch v1.0.0 --depth 1 \
  https://github.com/render-examples/cursor-cloud-agent-sandbox
cd cursor-cloud-agent-sandbox
npm ci
```

## Configure credentials

Copy the example environment file:

```bash
cp .env.example .env
```

Set:

```text
RENDER_API_KEY=
RENDER_WORKSPACE_ID=
CURSOR_API_KEY=
CURSOR_POOL=
```

`CURSOR_API_KEY` stays with the application. The template mints a single-claim
worker token and sends only that token to the Render Sandbox as a mode-`0600`
file.

## Run the coding agent

Make sure another worker will not claim work from the example pool, then run:

```bash
npm run agent -- "Create a hello world HTTP server in /workspace/output. Test it before you finish."
```

Expected summary:

```text
preflight     passed
agent         bc-...
claim         bc-... → pw_render_...
provision     sbx-...
worker        connected
result        FINISHED (stream)
agent         created and tested the server
outputs       copied 1 file to runs/run_.../output
cleanup       Cloud Agent deleted; claim released; sandbox terminated; Team Pool retained
```

## What happened

The template:

1. Creates a Cloud Agent targeting the configured any-repository Team Pool.
2. Claims its pending pool request with a stable worker ID.
3. Creates a Render Sandbox with the required egress policy.
4. Starts `agent worker` with the claim information and restricted token.
5. Confirms worker health and Cursor-side connection.
6. Attaches to the native run SSE stream and follows progress.
7. Streams the final result and copies files from `/workspace/output`.
8. Cancels active work if needed, releases the claim, permanently deletes the
   per-run Cloud Agent, and terminates the Render Sandbox.

The implementation uses Cursor's native Cloud Agent, run, pool, claim, and
worker APIs directly. It does not use a cross-provider adapter.

## How the template is organized

- [`src/agent.ts`](../src/agent.ts) owns the provider-native lifecycle and
  cleanup order.
- [`src/cursor.ts`](../src/cursor.ts) calls Cursor's Cloud Agent, run, pool,
  pending-request, claim, worker, cancellation, and deletion endpoints and
  consumes the run SSE stream with `Last-Event-ID`.
- [`src/render.ts`](../src/render.ts) uses `@renderinc/sdk` directly for
  asynchronous creation, polling, foreground streamed exec, uploads,
  downloads, and idempotent termination.
- [`src/launch-policy.ts`](../src/launch-policy.ts) contains the Render egress
  and credential compatibility seam.
- [`src/state.ts`](../src/state.ts) atomically records non-secret IDs and native
  events under `runs/<run_id>/`.
- [`scripts/install-executor.sh`](../scripts/install-executor.sh) installs the
  reviewed Cursor CLI release through Cursor's official installer.

## What you built

You built a one-shot Cursor runner that accepts a prompt, routes one Cloud Agent
to a Team Pool worker in a Render Sandbox, streams the native run events, and
copies optional output files back to your machine.

## Security

The Cursor team service-account key remains with the application when a
single-claim token is available. The public Render Sandbox SDK does not yet
expose a credential-broker primitive, so the restricted token is materialized
as a file. Code the agent runs can read any credential materialized in the same
sandbox. Do not inject the service-account key into the sandbox.

The Render hostname allow-list permits only the tested Cursor worker
(`api2.cursor.sh`, `api2direct.cursor.sh`), artifact, and CLI installation
destinations. Tool inputs and outputs pass through Cursor because Cursor hosts
the agent loop. The service-account key, run state, and downloaded files remain
local; the sandbox filesystem and single-claim token disappear when the
sandbox is terminated and the claim is released.

The worker executes without interactive approval because it is dedicated to
one claimed Cloud Agent inside the sandbox boundary. Treat every prompt and
repository as untrusted.

Cursor documents a moving installer URL, but not an exact-version selector or
release-artifact checksums. The template pins the reviewed installer SHA-256,
checks that it selects `2026.10.19-6bbf2c4`, verifies `agent --version`, and
disables auto-update. When Cursor changes the official installer, installation
fails closed until the pinned script is reviewed and updated.

Do not use production credentials or sensitive source code with this example
until you have reviewed its policy and credential settings.

## Customize the template

You can change:

- prompt handling in `src/agent.ts`;
- the worker version and installation in `scripts/install-executor.sh`;
- the sandbox lifetime in `src/render.ts` and egress policy in
  `src/launch-policy.ts`; and
- output collection in `src/outputs.ts`.

## Clean up

Cleanup runs automatically on success, failure, timeout, SIGINT, and SIGTERM.
If cleanup is incomplete, the command prints the Cursor Agent, run, worker, and
claim identifiers; the Render Sandbox ID; and exact manual cleanup commands.

The template retains the shared Team Pool.

## Troubleshooting

### The Team Pool is unavailable

Confirm Cursor Enterprise access, Self-Hosted Machines enablement, the pool
name, and service-account key scope.

### The request is not claimed

Confirm the pending request targets the configured pool and another worker has
not claimed it.

### The worker does not become ready

Check the worker stream, claim token, worker ID, pool name, and egress policy.
Readiness requires both the worker's local `/readyz` endpoint and Cursor's
`Get Worker By ID` response to show the expected active Cloud Agent.

### The CLI installer checksum changed

Cursor's official installer is a moving URL. Review the new installer, update
the pinned version and SHA-256 together in `scripts/install-executor.sh`, and
rerun the tests. Do not bypass the checksum.

### The agent produces no output files

Inspect `runs/<run_id>/events.jsonl` and the final result. Output files are
optional; prompts that need files should tell the agent to write them under
`/workspace/output`.

### Cleanup is incomplete

Run the commands printed by the agent runner. Release the claim, permanently
delete the per-run Cloud Agent, and terminate the Render Sandbox. Do not delete
the Team Pool.

## Next steps

- [Cursor Team Pools documentation](https://cursor.com/docs/cloud-agent/self-hosted/pool.md)
- [Render Sandboxes documentation](https://render.com/docs/sandboxes)
- [Template source](https://github.com/render-examples/cursor-cloud-agent-sandbox)
