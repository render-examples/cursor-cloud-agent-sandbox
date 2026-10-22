# Build a coding agent with Cursor Cloud Agents and Render Sandboxes

> **Note:** Render Sandboxes is in early access. Cursor Self-Hosted Machines
> and Team Pools are Cursor Enterprise features that a team administrator must
> enable.

[Cursor Cloud Agents](https://cursor.com/docs/cloud-agent/self-hosted/pool.md)
hosts the agent loop, inference, and conversation, and can route the agent's
work to a self-hosted worker in a Team Pool. Render Sandboxes gives that worker
an isolated, ephemeral Linux environment in your Render workspace, with
outbound traffic denied by default.

In this tutorial, you build a coding agent that accepts a prompt, runs the Cloud
Agent's commands and file edits on an `agent worker` in a Render Sandbox, and
copies the output files to your machine. The
[template source](https://github.com/render-examples/cursor-cloud-agent-sandbox)
contains everything you run here.

Time to complete: 20 minutes, after access is enabled

## Prerequisites

1. A Render workspace with Sandboxes enabled, a
   [Render API key](https://render.com/docs/api), and your workspace ID
   (`tea-...`).
2. Cursor Enterprise with Self-Hosted Machines enabled, and a team
   service-account API key with agent scope.
3. An existing, named any-repository Team Pool. The runner rejects a missing or
   repository-backed pool before it creates anything.
4. [Node.js](https://nodejs.org/) 22 or later and Git.

The Team Pool is shared configuration. The template creates and deletes only a
per-run Cloud Agent and its claim.

## 1. Get the template

Clone the tagged release and install its dependencies:

```bash
git clone --branch v1.0.0 --depth 1 \
  https://github.com/render-examples/cursor-cloud-agent-sandbox
cd cursor-cloud-agent-sandbox
npm ci
```

## 2. Configure credentials

Copy the example environment file:

```bash
cp .env.example .env
```

Fill in your values:

```sh
RENDER_API_KEY=rnd_your-render-api-key
RENDER_WORKSPACE_ID=tea-your-workspace-id
CURSOR_API_KEY=your-service-account-key
CURSOR_POOL=your-any-repo-pool
```

`CURSOR_API_KEY` stays on your machine. For each run, the runner claims the
Cloud Agent's pool request and sends only that claim's single-use token to the
sandbox, as a mode-`0600` file.

## 3. Run the agent

Make sure no other worker will claim work from the pool, then run the agent
with a prompt:

```bash
npm run agent -- "Create a hello world HTTP server in /workspace/output. Test it before you finish."
```

You should see the Cloud Agent's run events stream to the console. Installer and
worker logs are omitted here:

```text
preflight     passed
agent         bc-...
claim         bc-... → pw_render_...
provision     sbx-...
worker        connected
cursor:status RUNNING
cursor:tool   edit_file completed
cursor:tool   run_terminal_cmd completed
cursor:result FINISHED
agent         I created /workspace/output/server.js and confirmed it responds with "Hello, world!".
result        FINISHED (stream)
outputs       copied 1 file to runs/run_.../output
cleanup       Cloud Agent deleted; claim released; sandbox terminated; Team Pool retained
run           runs/run_...
```

The agent wrote the server, tested it inside the sandbox, and the runner copied
it to your machine. Then the runner released the claim, deleted the Cloud
Agent, and terminated the sandbox.

## 4. Understand how it works

[`src/agent.ts`](https://github.com/render-examples/cursor-cloud-agent-sandbox/blob/v1.0.0/src/agent.ts)
runs one Cloud Agent from start to finish. A Cloud Agent must exist before its
run can be streamed or claimed, so the sandbox is created after the claim.
Simplified, the lifecycle is:

```ts
await cursor.assertAnyRepoPool(pool, signal);
const created = await cursor.createAgent(prompt, pool);
const terminal = cursor.waitForRunTerminal(agentId, runId, { signal, onEvent });

const pending = await cursor.waitForPendingRequest(agentId, pool, signal);
const claim = await cursor.claimPendingRequest(pending.id, workerId, signal);

const sandboxId = await sandbox.create({ workerId, pool, timeoutSeconds }, saveSandboxId, signal);
await sandbox.installCursorCli(sandboxId, installScriptPath, onOutput, signal);
await sandbox.putClaimToken(sandboxId, claim.token);
worker = sandbox.startWorker(sandboxId, { signal, onOutput });
await waitForWorkerReady({ cursor, sandbox, sandboxId, workerId, agentId, signal });

const result = await terminal;
await collectOutputs({ sandbox, sandboxId, destination, forbiddenValues, signal });

// In `finally`, on success, failure, timeout, or Ctrl+C:
await cleanupRun({ cursor, sandbox, store, worker, claimFailed });
```

Here is what the key pieces do:

| Piece | Purpose |
| --- | --- |
| `cursor.assertAnyRepoPool()` | Confirms the Team Pool exists and isn't tied to a repository. |
| `cursor.createAgent()` | Creates the Cloud Agent and its first run, targeting the pool. |
| `cursor.waitForRunTerminal()` | Follows the run's native SSE stream, resumes with `Last-Event-ID`, and falls back to polling the run after stream retention expires. |
| `cursor.claimPendingRequest()` | Claims the agent's pool request for this run's worker ID and returns a single-claim token. |
| `sandboxLaunchConfiguration()` | Declares the sandbox's egress allow-list and worker environment, in [`src/launch-policy.ts`](https://github.com/render-examples/cursor-cloud-agent-sandbox/blob/v1.0.0/src/launch-policy.ts). |
| `install-executor.sh` | Installs Cursor Agent CLI `2026.10.19-6bbf2c4` after checking its pinned SHA-256, in [`scripts/install-executor.sh`](https://github.com/render-examples/cursor-cloud-agent-sandbox/blob/v1.0.0/scripts/install-executor.sh). |
| `materializeSingleClaimToken()` | Writes the claim token to a mode-`0600` file without putting it in a command line. |
| `waitForWorkerReady()` | Waits for both the worker's local `/readyz` endpoint and Cursor's worker record to show the expected Cloud Agent. |
| `collectOutputs()` | Copies regular files from `/workspace/output` to your machine. |
| `cleanupRun()` | Cancels active work, releases the claim, deletes the Cloud Agent, and terminates the sandbox, each with its own timeout, in [`src/cleanup.ts`](https://github.com/render-examples/cursor-cloud-agent-sandbox/blob/v1.0.0/src/cleanup.ts). |

Each run writes its state to `runs/<run_id>/`: `run.json` (resource IDs,
egress policy, and cleanup status, but no credentials), the native
`events.jsonl`, and `result.txt`.

## What you built

You built a coding agent that:

- Accepts a natural-language coding task
- Runs the Cloud Agent's commands and file edits on a Team Pool worker in an
  isolated Render Sandbox with default-deny egress
- Streams native Cloud Agent run events as it works
- Copies deliverable files back to your machine and cleans up every per-run
  resource

## Security

Your service-account key never enters the sandbox. Any code the agent runs can
read credentials that are present in the sandbox, including the single-claim
token. The current Render SDK has no credential broker, so the template writes
that token to a file. That behavior is isolated in `src/launch-policy.ts`, so a
broker can replace it without changing the lifecycle.

The sandbox's egress policy is a default-deny allow-list. At run time, the
worker needs Cursor's worker hosts (`api2.cursor.sh` and
`api2direct.cursor.sh`), its artifact hosts, and `cursor.com`.
`downloads.cursor.com` is needed only to download the CLI, but the SDK cannot
narrow a policy after the sandbox is created, so it stays allowed for this
short-lived run. Tool inputs and outputs pass through Cursor, because Cursor
hosts the agent loop.

The worker runs without interactive approval, because it serves exactly one
claimed Cloud Agent inside the sandbox boundary. Treat every prompt as
untrusted. Don't use production credentials or sensitive source code with this
example until you have reviewed its policy and credential settings.

## Customize the agent

- **Prompt:** the runner sends your prompt as the Cloud Agent's first message,
  in `createAgent()` in `src/cursor.ts`.
- **Toolchain:** install more tools in `scripts/install-executor.sh`, and add
  their download hosts to `INSTALL_DESTINATIONS` in `src/launch-policy.ts`.
- **Egress:** add hosts the agent needs while it works to
  `RUNTIME_DESTINATIONS` in `src/launch-policy.ts`.
- **Lifetime:** pass `--timeout <seconds>` or set `AGENT_TIMEOUT_SECONDS` (the
  default is 600). The sandbox lifetime is derived from it in `src/agent.ts`.
- **Outputs:** pass `--output <path>` to copy files somewhere other than
  `runs/<run_id>/output`, or change collection in `src/outputs.ts`.

## Clean up

Cleanup runs automatically after success, failure, timeout, Ctrl+C, and
SIGTERM. The runner keeps the shared Team Pool.

If a cleanup step fails, the runner prints the exact commands to finish it:

```bash
curl -u "$CURSOR_API_KEY:" -X POST "https://api.cursor.com/v1/agents/$AGENT_ID/runs/$RUN_ID/cancel"
curl -u "$CURSOR_API_KEY:" -X POST "https://api.cursor.com/v0/private-workers/claims/$AGENT_ID/release"
curl -u "$CURSOR_API_KEY:" -X DELETE "https://api.cursor.com/v1/agents/$AGENT_ID"
RENDER_WORKSPACE="$RENDER_WORKSPACE_ID" render ea sandboxes stop "$SANDBOX_ID" --confirm
```

If Cloud Agent creation fails without a clear answer from the API, the runner
also prints a `reconcile` command. It uses
[List Agents](https://cursor.com/docs/cloud-agent/api/endpoints.md) to show your
newest Cloud Agents, along with the run's start time, so you can find and
permanently delete any agent that may have been created.

## Troubleshooting

### Preflight fails

Confirm that Self-Hosted Machines is enabled, the pool name is correct, the pool
is an any-repository pool, and the service-account key has agent scope.

### The pool request is never claimed

Confirm the request targets the configured pool and that another worker hasn't
claimed it first.

### The worker never becomes ready

Check the `[worker:stderr]` lines, the claim token, and the egress policy.
Readiness requires both the worker's `/readyz` endpoint and Cursor's worker
record to show the expected Cloud Agent.

### The agent produces no output files

Inspect `runs/<run_id>/events.jsonl` and `result.txt`. Output files are
optional, so prompts that need files should ask the agent to write them under
`/workspace/output`.

### Cleanup is incomplete

Run the commands that the runner printed. Release the claim, delete the per-run
Cloud Agent, and terminate the sandbox, but not the shared Team Pool.

## Next steps

- [Cursor Team Pools documentation](https://cursor.com/docs/cloud-agent/self-hosted/pool.md)
- [Render Sandboxes documentation](https://render.com/docs/sandboxes)
- [Build a coding agent with OpenAI Agents API and Render Sandboxes](https://render.com/docs/sandboxes/hosted-agents/openai)
- [Build a coding agent with Claude Managed Agents and Render Sandboxes](https://render.com/docs/sandboxes/hosted-agents/claude-managed-agents)
- [Template source](https://github.com/render-examples/cursor-cloud-agent-sandbox)
