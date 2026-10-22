import { createHash } from "node:crypto";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { cleanupRun, printManualCleanup } from "./cleanup.js";
import type { Config } from "./config.js";
import {
  CursorApiError,
  CursorClient,
  type CursorSseEvent,
  type RunTerminal,
} from "./cursor.js";
import { EGRESS_DESTINATIONS } from "./launch-policy.js";
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
  const secrets = [config.cursorApiKey, config.renderApiKey];
  const store = await RunStore.create({
    ...(options.dependencies?.runsRoot
      ? { rootDirectory: options.dependencies.runsRoot }
      : {}),
    pool: config.cursorPool,
    timeoutSeconds: config.timeoutSeconds,
    secretValues: secrets,
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

  let worker: WorkerProcess | undefined;
  let workerConnected = false;
  let claimFailed = false;
  let primaryError: unknown;
  let result = "";
  let outputFiles: string[] = [];
  const writeWorkerOutput = (stream: "stdout" | "stderr", data: string) =>
    writeRedacted(stream, data, secrets);

  try {
    await cursor.assertAnyRepoPool(config.cursorPool, workController.signal);
    log("preflight", "passed");

    await store.update({ phase: "agent", cleanup: { cursor_agent: "pending" } });
    let created;
    try {
      created = await cursor.createAgent(prompt, config.cursorPool);
    } catch (error) {
      if (isAmbiguousMutationError(error)) {
        await store.update({
          ambiguous_mutation: `Cloud Agent creation may have succeeded without returning an ID. Reconcile before retrying: curl -u "$CURSOR_API_KEY:" "\${CURSOR_API_BASE_URL:-https://api.cursor.com}/v1/agents"`,
        });
      }
      throw error;
    }
    await store.update({
      cursor_agent_id: created.agent.id,
      cursor_run_id: created.run.id,
    });
    log("agent", created.agent.id);
    workController.signal.throwIfAborted();

    const terminalPromise = cursor.waitForRunTerminal(
      created.agent.id,
      created.run.id,
      {
        signal: workController.signal,
        onEvent: async (event) => {
          await recordCursorEvent(store, event);
          printCursorEvent(event, secrets);
        },
      },
    );
    void terminalPromise.catch(() => undefined);
    const endedBefore = (milestone: string) =>
      terminalPromise.then((terminal): never => {
        throw new Error(`Cursor run ended with ${terminal.run.status} before ${milestone}`);
      });

    const pending = await Promise.race([
      cursor.waitForPendingRequest(
        created.agent.id,
        config.cursorPool,
        workController.signal,
      ),
      endedBefore("its pool request was claimed"),
    ]);
    const workerId = stableWorkerId(store.snapshot().run_id);
    await store.update({
      phase: "claim",
      cursor_worker_id: workerId,
      cursor_claim_state: "intent",
      cleanup: { cursor_claim: "pending" },
    });
    const claim = await cursor.claimPendingRequest(
      pending.id,
      workerId,
      workController.signal,
    );
    secrets.push(claim.token);
    store.addSecret(claim.token);
    await store.update({ cursor_claim_state: "claimed" });
    log("claim", `${claim.id} → ${workerId}`);

    await store.update({
      phase: "provision",
      effective_egress_policy: [...EGRESS_DESTINATIONS],
      cleanup: { sandbox: "pending" },
    });
    const sandboxId = await sandbox.create(
      {
        workerId,
        pool: config.cursorPool,
        timeoutSeconds: Math.min(config.timeoutSeconds + 180, 86_400),
      },
      async (id) => {
        await store.update({ sandbox_id: id });
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
    await store.update({ phase: "install" });
    await sandbox.installCursorCli(
      sandboxId,
      installScriptPath,
      writeWorkerOutput,
      workController.signal,
    );

    await sandbox.putClaimToken(sandboxId, claim.token);
    await store.update({ phase: "worker" });
    worker = sandbox.startWorker(sandboxId, {
      signal: workController.signal,
      onOutput: writeWorkerOutput,
    });
    const fatalWorker = worker.completion.then((exitCode) => {
      if (exitCode !== 0) {
        throw new Error(`Cursor worker exited with code ${exitCode}`);
      }
      return new Promise<never>(() => undefined);
    });
    void fatalWorker.catch(() => undefined);

    await waitForWorkerReady({
      cursor,
      sandbox,
      sandboxId,
      workerId,
      agentId: created.agent.id,
      signal: workController.signal,
      fatalWorker,
      prematureTerminal: endedBefore("the worker became ready"),
    });
    workerConnected = true;
    await store.update({ cursor_claim_state: "connected" });
    log("worker", "connected");

    await store.update({ phase: "run" });
    const terminal: RunTerminal = await Promise.race([terminalPromise, fatalWorker]);
    result = terminal.run.result ?? "";
    await store.writeResult(result);
    if (result) log("agent", result);
    log("result", `${terminal.run.status} (${terminal.source})`);
    if (terminal.run.status !== "FINISHED") {
      throw new Error(`Cursor run ended with ${terminal.run.status}`);
    }

    await store.update({ phase: "outputs" });
    const destination = config.outputDirectory ?? store.outputDirectory;
    outputFiles = await collectOutputs({
      sandbox,
      sandboxId,
      destination,
      forbiddenValues: secrets,
      signal: workController.signal,
    });
    log(
      "outputs",
      `copied ${outputFiles.length} file${outputFiles.length === 1 ? "" : "s"} to ${destination}`,
    );
  } catch (error) {
    primaryError = workController.signal.aborted ? workController.signal.reason : error;
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
          `Render Sandbox worker failed to start: ${safeErrorMessage(primaryError)}`,
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
    await store.update({ phase: "cleanup" });
    const cleanupErrors = await cleanupRun({
      cursor,
      sandbox,
      store,
      ...(worker ? { worker } : {}),
      claimFailed,
    });
    const { ambiguous_mutation: ambiguousMutation } = store.snapshot();
    if (ambiguousMutation) console.error(`reconcile     ${ambiguousMutation}`);
    if (cleanupErrors.length > 0) {
      printManualCleanup(store.snapshot());
      const cleanupError = new Error(
        `Cleanup incomplete: ${cleanupErrors.map(safeErrorMessage).join("; ")}`,
      );
      primaryError = primaryError
        ? new AggregateError([primaryError, cleanupError], "Run failed and cleanup was incomplete")
        : cleanupError;
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
  const isReady = async (): Promise<boolean> => {
    if (!(await options.sandbox.isWorkerReady(options.sandboxId, options.signal))) {
      return false;
    }
    try {
      const worker = await options.cursor.getWorker(options.workerId, options.signal);
      return (
        worker.workerId === options.workerId &&
        worker.activeBcId === options.agentId &&
        worker.isInUse
      );
    } catch (error) {
      if (error instanceof CursorApiError && error.status === 404) return false;
      throw error;
    }
  };

  while (true) {
    options.signal.throwIfAborted();
    if (await Promise.race([isReady(), options.fatalWorker, options.prematureTerminal])) {
      return;
    }
    await sleep(1_000, undefined, { signal: options.signal });
  }
}

/**
 * True when a failed mutation may still have taken effect on the server, so its
 * resource must be reconciled before retrying.
 */
function isAmbiguousMutationError(error: unknown): boolean {
  if (!(error instanceof CursorApiError)) return true;
  return error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500;
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

function log(label: string, message: string): void {
  console.log(`${label.padEnd(14)}${message}`);
}
