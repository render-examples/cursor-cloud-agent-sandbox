import { setTimeout as sleep } from "node:timers/promises";
import {
  CLEANUP_REQUEST_TIMEOUT_MS,
  CursorApiError,
  isTerminalStatus,
  type CursorClient,
} from "./cursor.js";
import type { RenderSandbox, WorkerProcess } from "./render.js";
import type { RunState, RunStore } from "./state.js";

export type CleanupCursor = Pick<
  CursorClient,
  "getRun" | "cancelRun" | "releaseClaim" | "deleteAgent"
>;

export type CleanupSandbox = Pick<RenderSandbox, "terminate">;

const SANDBOX_TERMINATE_TIMEOUT_MS = 30_000;

/**
 * Cancels active work, releases the claim, deletes the per-run Cloud Agent, and
 * terminates the sandbox. Each step is bounded and attempted independently.
 */
export async function cleanupRun(options: {
  cursor: CleanupCursor;
  sandbox: CleanupSandbox;
  store: RunStore;
  worker?: WorkerProcess;
  claimFailed: boolean;
  sandboxTimeoutMs?: number;
}): Promise<unknown[]> {
  const errors: unknown[] = [];
  const state = options.store.snapshot();

  if (state.cursor_agent_id && state.cursor_run_id) {
    try {
      const run = await options.cursor.getRun(
        state.cursor_agent_id,
        state.cursor_run_id,
        AbortSignal.timeout(CLEANUP_REQUEST_TIMEOUT_MS),
      );
      if (!isTerminalStatus(run.status)) {
        try {
          await options.cursor.cancelRun(state.cursor_agent_id, state.cursor_run_id);
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
      await options.store.update({ cleanup: { cursor_agent: "complete" } });
    } catch (error) {
      errors.push(error);
      await options.store.update({ cleanup: { cursor_agent: "failed" } });
    }
  }

  options.worker?.stop();

  if (state.sandbox_id) {
    try {
      await withTimeout(
        options.sandbox.terminate(state.sandbox_id),
        options.sandboxTimeoutMs ?? SANDBOX_TERMINATE_TIMEOUT_MS,
        "Render Sandbox termination",
      );
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

/** The release endpoint returns 400 until the worker has disconnected. */
async function releaseClaimWithRetry(
  cursor: Pick<CursorClient, "releaseClaim">,
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

export function printManualCleanup(state: Readonly<RunState>): void {
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function log(label: string, message: string): void {
  console.log(`${label.padEnd(14)}${message}`);
}
