import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import {
  CursorApiError,
  CursorClient,
  isTerminalStatus,
  type CursorSseEvent,
  type RunTerminal,
} from "./cursor.js";
import { PUBLIC_SDK_EGRESS_POLICY } from "./launch-policy.js";
import { collectOutputs } from "./outputs.js";
import { RenderSandbox, type WorkerProcess } from "./render.js";
import { redact, RunStore } from "./state.js";

export interface AgentRunResult {
  runDirectory: string;
  result: string;
  outputFiles: string[];
}

interface Dependencies {
  cursor?: CursorOperations;
  sandbox?: SandboxOperations;
  runsRoot?: string;
  installScriptPath?: string;
}

type CursorOperations = Pick<
  CursorClient,
  | "assertAnyRepoPool"
  | "createAgent"
  | "waitForRunTerminal"
  | "waitForPendingRequest"
  | "claimPendingRequest"
  | "getWorker"
  | "getRun"
  | "cancelRun"
  | "releaseClaim"
  | "failClaim"
  | "deleteAgent"
>;

type SandboxOperations = Pick<
  RenderSandbox,
  | "create"
  | "installCursorCli"
  | "putClaimToken"
  | "startWorker"
  | "isWorkerReady"
  | "listRegularOutputFiles"
  | "downloadFile"
  | "terminate"
>;

export async function runAgent(
  config: Config,
  prompt: string,
  options: { signal?: AbortSignal; dependencies?: Dependencies } = {},
): Promise<AgentRunResult> {
  const cursor =
    options.dependencies?.cursor ??
    new CursorClient(config.cursorApiKey, config.cursorApiBaseUrl);
  const sandbox =
    options.dependencies?.sandbox ??
    new RenderSandbox({
      apiKey: config.renderApiKey,
      workspaceId: config.renderWorkspaceId,
    });
  const store = await RunStore.create({
    ...(options.dependencies?.runsRoot
      ? { rootDirectory: options.dependencies.runsRoot }
      : {}),
    pool: config.cursorPool,
    timeoutSeconds: config.timeoutSeconds,
    secretValues: [config.cursorApiKey, config.renderApiKey],
  });
  const workController = new AbortController();
  const onExternalAbort = () =>
    workController.abort(options.signal?.reason ?? new Error("Run cancelled"));
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  const deadlineTimer = setTimeout(
    () =>
      workController.abort(
        new Error(`Agent deadline exceeded after ${config.timeoutSeconds} seconds`),
      ),
    config.timeoutSeconds * 1_000,
  );

  let claimToken: string | undefined;
  let worker: WorkerProcess | undefined;
  let workerConnected = false;
  let claimFailed = false;
  let terminalPromise: Promise<RunTerminal> | undefined;
  let primaryError: unknown;
  let result = "";
  let outputFiles: string[] = [];

  try {
    await cursor.assertAnyRepoPool(config.cursorPool, workController.signal);
    log("preflight", "passed");

    await store.update({
      phase: "cursor-agent-create-intent",
      cleanup: { cursor_agent: "pending" },
    });
    const created = await cursor.createAgent(
      prompt,
      config.cursorPool,
      workController.signal,
    );
    await store.update({
      phase: "cursor-agent-created",
      cursor_agent_id: created.agent.id,
      cursor_run_id: created.run.id,
    });
    log("agent", created.agent.id);

    terminalPromise = cursor.waitForRunTerminal(
      created.agent.id,
      created.run.id,
      {
        signal: workController.signal,
        onEvent: async (event) => {
          await recordCursorEvent(store, event);
          printCursorEvent(event, [
            config.cursorApiKey,
            config.renderApiKey,
            ...(claimToken ? [claimToken] : []),
          ]);
        },
      },
    );
    void terminalPromise.catch(() => undefined);

    const prematureTerminal = terminalPromise.then((terminal) => {
      throw new Error(
        `Cursor run ended with ${terminal.run.status} before its pool request was claimed`,
      );
    });
    const pending = await Promise.race([
      cursor.waitForPendingRequest(
        created.agent.id,
        config.cursorPool,
        workController.signal,
      ),
      prematureTerminal,
    ]);
    const workerId = stableWorkerId(store.snapshot().run_id);
    await store.update({
      phase: "cursor-claim-intent",
      cursor_worker_id: workerId,
      cursor_claim_state: "intent",
      cleanup: { cursor_claim: "pending" },
    });
    const claim = await cursor.claimPendingRequest(
      pending.id,
      workerId,
      workController.signal,
    );
    claimToken = claim.token;
    store.addSecret(claimToken);
    await store.update({
      phase: "cursor-claimed",
      cursor_claim_state: "claimed",
    });
    log("claim", `${claim.id} → ${workerId}`);

    await store.update({
      phase: "sandbox-create-intent",
      effective_egress_policy: JSON.stringify(PUBLIC_SDK_EGRESS_POLICY),
      cleanup: { sandbox: "pending" },
    });
    const sandboxId = await sandbox.create(
      {
        workerId,
        pool: config.cursorPool,
        timeoutSeconds: Math.min(config.timeoutSeconds + 180, 86_400),
      },
      async (id) => {
        await store.update({ phase: "sandbox-creating", sandbox_id: id });
        log("provision", id);
      },
      workController.signal,
    );

    const installScriptPath =
      options.dependencies?.installScriptPath ??
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../scripts/install-executor.sh",
      );
    await store.update({ phase: "installing-worker" });
    await sandbox.installCursorCli(
      sandboxId,
      installScriptPath,
      (stream, data) =>
        writeRedacted(stream, data, [
          config.cursorApiKey,
          config.renderApiKey,
          claimToken!,
        ]),
      workController.signal,
    );

    await sandbox.putClaimToken(sandboxId, claimToken);
    await store.update({ phase: "starting-worker" });
    worker = sandbox.startWorker(sandboxId, {
      signal: workController.signal,
      onOutput: (stream, data) =>
        writeRedacted(stream, data, [
          config.cursorApiKey,
          config.renderApiKey,
          claimToken!,
        ]),
    });
    const fatalWorker = worker.completion.then((exitCode) => {
      if (exitCode !== 0) {
        throw new Error(`Cursor worker exited with code ${exitCode}`);
      }
      return new Promise<never>(() => undefined);
    });

    await waitForWorkerReady({
      cursor,
      sandbox,
      sandboxId,
      workerId,
      agentId: created.agent.id,
      signal: workController.signal,
      fatalWorker,
      prematureTerminal: terminalPromise.then((terminal) => {
        throw new Error(
          `Cursor run ended with ${terminal.run.status} before the worker became ready`,
        );
      }),
    });
    workerConnected = true;
    await store.update({
      phase: "worker-connected",
      cursor_claim_state: "connected",
    });
    log("worker", "connected");

    await store.update({ phase: "run" });
    const terminal = await Promise.race([terminalPromise, fatalWorker]);
    result = terminal.run.result ?? "";
    await store.writeResult(result);
    log("result", `${terminal.run.status} (${terminal.source})`);
    if (result) log("agent", result);
    if (terminal.run.status !== "FINISHED") {
      throw new Error(`Cursor run ended with ${terminal.run.status}`);
    }

    await store.update({ phase: "outputs" });
    const destination = config.outputDirectory ?? store.outputDirectory;
    outputFiles = await collectOutputs({
      sandbox,
      sandboxId,
      destination,
      forbiddenValues: [
        config.cursorApiKey,
        config.renderApiKey,
        claimToken,
      ],
      signal: workController.signal,
    });
    log(
      "outputs",
      `copied ${outputFiles.length} file${outputFiles.length === 1 ? "" : "s"} to ${destination}`,
    );
  } catch (error) {
    primaryError = error;
    workController.abort(error);
    const snapshot = store.snapshot();
    if (
      snapshot.cursor_agent_id &&
      snapshot.cursor_claim_state === "claimed" &&
      !workerConnected
    ) {
      try {
        await cursor.failClaim(
          snapshot.cursor_agent_id,
          `Render Sandbox worker failed to start: ${safeErrorMessage(error)}`,
        );
        claimFailed = true;
        await store.update({
          cursor_claim_state: "failed",
          cleanup: { cursor_claim: "complete" },
        });
      } catch {
        // Cleanup below attempts release and reports any remaining claim.
      }
    }
  } finally {
    clearTimeout(deadlineTimer);
    options.signal?.removeEventListener("abort", onExternalAbort);
    const cleanupErrors = await cleanup({
      cursor,
      sandbox,
      store,
      ...(worker ? { worker } : {}),
      claimFailed,
    });
    if (cleanupErrors.length > 0) {
      printManualCleanup(store.snapshot());
      if (!primaryError) {
        primaryError = new Error(
          `Cleanup incomplete: ${cleanupErrors.map(safeErrorMessage).join("; ")}`,
        );
      }
    }
  }

  if (primaryError) throw primaryError;
  return { runDirectory: store.directory, result, outputFiles };
}

async function waitForWorkerReady(options: {
  cursor: CursorOperations;
  sandbox: SandboxOperations;
  sandboxId: string;
  workerId: string;
  agentId: string;
  signal: AbortSignal;
  fatalWorker: Promise<never>;
  prematureTerminal: Promise<never>;
}): Promise<void> {
  while (true) {
    options.signal.throwIfAborted();
    const readiness = (async () => {
      const sandboxReady = await options.sandbox.isWorkerReady(
        options.sandboxId,
        options.signal,
      );
      let cursorReady = false;
      try {
        const worker = await options.cursor.getWorker(
          options.workerId,
          options.signal,
        );
        cursorReady =
          worker.workerId === options.workerId &&
          worker.activeBcId === options.agentId &&
          worker.isInUse;
      } catch (error) {
        if (!(error instanceof CursorApiError) || error.status !== 404) throw error;
      }
      return sandboxReady && cursorReady;
    })();
    if (
      await Promise.race([
        readiness,
        options.fatalWorker,
        options.prematureTerminal,
      ])
    ) {
      return;
    }
    await sleep(1_000, options.signal);
  }
}

async function cleanup(options: {
  cursor: CursorOperations;
  sandbox: SandboxOperations;
  store: RunStore;
  worker?: WorkerProcess;
  claimFailed: boolean;
}): Promise<unknown[]> {
  const errors: unknown[] = [];
  const state = options.store.snapshot();

  if (state.cursor_agent_id && state.cursor_run_id) {
    try {
      const run = await options.cursor.getRun(
        state.cursor_agent_id,
        state.cursor_run_id,
      );
      if (!isTerminalStatus(run.status)) {
        try {
          await options.cursor.cancelRun(
            state.cursor_agent_id,
            state.cursor_run_id,
          );
        } catch (error) {
          if (
            !(error instanceof CursorApiError) ||
            !(error.status === 409 && error.code === "run_not_cancellable")
          ) {
            throw error;
          }
        }
      }
    } catch (error) {
      errors.push(error);
    }
  }

  if (
    state.cursor_agent_id &&
    state.cleanup.cursor_claim !== "not-created" &&
    !options.claimFailed
  ) {
    try {
      await releaseClaimWithRetry(options.cursor, state.cursor_agent_id);
      await options.store.update({
        cursor_claim_state: "released",
        cleanup: { cursor_claim: "complete" },
      });
    } catch (error) {
      errors.push(error);
      await options.store.update({ cleanup: { cursor_claim: "failed" } });
    }
  }

  if (state.cursor_agent_id) {
    try {
      await options.cursor.deleteAgent(state.cursor_agent_id);
      await options.store.update({
        cleanup: { cursor_agent: "complete" },
      });
    } catch (error) {
      errors.push(error);
      await options.store.update({ cleanup: { cursor_agent: "failed" } });
    }
  }

  options.worker?.stop();

  if (state.sandbox_id) {
    try {
      await options.sandbox.terminate(state.sandbox_id);
      await options.store.update({ cleanup: { sandbox: "complete" } });
    } catch (error) {
      errors.push(error);
      await options.store.update({ cleanup: { sandbox: "failed" } });
    }
  }

  await options.store.update({ phase: errors.length === 0 ? "complete" : "cleanup-failed" });
  log(
    "cleanup",
    errors.length === 0
      ? "Cloud Agent deleted; claim released; sandbox terminated; Team Pool retained"
      : `incomplete (${errors.length} error${errors.length === 1 ? "" : "s"})`,
  );
  return errors;
}

async function releaseClaimWithRetry(
  cursor: CursorOperations,
  agentId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await cursor.releaseClaim(agentId);
      return;
    } catch (error) {
      if (error instanceof CursorApiError && error.status === 404) return;
      if (error instanceof CursorApiError && error.status === 400 && attempt < 4) {
        await sleep(1_000);
        continue;
      }
      throw error;
    }
  }
}

async function recordCursorEvent(
  store: RunStore,
  event: CursorSseEvent,
): Promise<void> {
  await store.appendEvent(event);
  if (event.id) await store.update({ last_event_id: event.id });
}

function printCursorEvent(event: CursorSseEvent, secrets: string[]): void {
  const data = redact(event.data, secrets) as Record<string, unknown>;
  if (event.event === "status") {
    log("cursor:status", String(data.status ?? ""));
  } else if (event.event === "assistant") {
    log("cursor:assistant", String(data.text ?? ""));
  } else if (event.event === "tool_call") {
    log(
      "cursor:tool",
      `${String(data.name ?? "unknown")} ${String(data.status ?? "")}`,
    );
  } else if (event.event === "result") {
    log("cursor:result", String(data.status ?? ""));
  } else if (event.event === "error") {
    log("cursor:error", String(data.message ?? "stream error"));
  }
}

function writeRedacted(
  stream: "stdout" | "stderr",
  data: string,
  secrets: string[],
): void {
  const safe = secrets.reduce(
    (value, secret) => value.split(secret).join("[REDACTED]"),
    data,
  );
  const target = stream === "stdout" ? process.stdout : process.stderr;
  target.write(`[worker:${stream}] ${safe}`);
}

function stableWorkerId(runId: string): string {
  return `pw_render_${createHash("sha256").update(runId).digest("hex").slice(0, 24)}`;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printManualCleanup(state: ReturnType<RunStore["snapshot"]>): void {
  console.error("Manual cleanup commands:");
  if (state.cursor_run_id && state.cursor_agent_id) {
    console.error(
      `curl -u "$CURSOR_API_KEY:" -X POST "\${CURSOR_API_BASE_URL:-https://api.cursor.com}/v1/agents/${state.cursor_agent_id}/runs/${state.cursor_run_id}/cancel"`,
    );
  }
  if (state.cursor_agent_id) {
    console.error(
      `curl -u "$CURSOR_API_KEY:" -X POST "\${CURSOR_API_BASE_URL:-https://api.cursor.com}/v0/private-workers/claims/${state.cursor_agent_id}/release"`,
    );
    console.error(
      `curl -u "$CURSOR_API_KEY:" -X DELETE "\${CURSOR_API_BASE_URL:-https://api.cursor.com}/v1/agents/${state.cursor_agent_id}"`,
    );
  }
  if (state.sandbox_id) {
    console.error(
      `RENDER_WORKSPACE="$RENDER_WORKSPACE_ID" render ea sandboxes stop ${state.sandbox_id} --confirm`,
    );
  }
}

function log(label: string, message: string): void {
  console.log(`${label.padEnd(14)}${message}`);
}

async function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
