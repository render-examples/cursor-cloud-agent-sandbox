import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../../src/agent.js";
import { cleanupRun } from "../../src/cleanup.js";
import type { Config } from "../../src/config.js";
import { RunStore } from "../../src/state.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const config: Config = {
  renderApiKey: "render-secret",
  renderWorkspaceId: "tea-1",
  cursorApiKey: "cursor-secret",
  cursorPool: "sandbox",
  cursorApiBaseUrl: "https://api.cursor.test",
  timeoutSeconds: 30,
};

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(process.cwd(), ".test-lifecycle-"));
  temporaryDirectories.push(root);
  return root;
}

async function readState(root: string): Promise<Record<string, unknown>> {
  const [runId] = await readdir(root);
  return JSON.parse(await readFile(path.join(root, runId!, "run.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

function fakes(calls: string[]) {
  let finishRun!: () => void;
  const runCanFinish = new Promise<void>((resolve) => {
    finishRun = resolve;
  });

  const cursor = {
    assertAnyRepoPool: vi.fn(async () => {
      calls.push("pool:validate");
    }),
    createAgent: vi.fn(async () => {
      calls.push("agent:create");
      return {
        agent: { id: "bc-1", latestRunId: "run-1", status: "ACTIVE" },
        run: { id: "run-1", agentId: "bc-1", status: "CREATING" as const },
      };
    }),
    waitForRunTerminal: vi.fn(
      async (
        _agentId: string,
        _runId: string,
        options: { onEvent: (event: unknown) => Promise<void> },
      ) => {
        await options.onEvent({
          id: "evt-1",
          event: "tool_call",
          data: { name: "run_terminal_cmd", status: "completed" },
        });
        await runCanFinish;
        return {
          source: "stream" as const,
          run: {
            id: "run-1",
            agentId: "bc-1",
            status: "FINISHED" as const,
            result: "completed",
          },
        };
      },
    ),
    waitForPendingRequest: vi.fn(async () => ({
      id: "bc-1",
      labels: [{ key: "pool", value: "sandbox" }],
    })),
    claimPendingRequest: vi.fn(async () => {
      calls.push("claim");
      return {
        id: "bc-1",
        workerId: "pw-fake",
        token: "single-claim-token",
        expiresAt: "2026-10-22T00:00:00.000Z",
      };
    }),
    getWorker: vi.fn(async (workerId: string) => {
      setTimeout(finishRun, 0);
      return {
        workerId,
        activeBcId: "bc-1",
        isInUse: true,
        connectedAtMs: Date.now(),
      };
    }),
    getRun: vi.fn(async () => ({
      id: "run-1",
      agentId: "bc-1",
      status: "FINISHED" as const,
      result: "completed",
    })),
    cancelRun: vi.fn(async () => {
      calls.push("run:cancel");
    }),
    releaseClaim: vi.fn(async () => {
      calls.push("claim:release");
    }),
    failClaim: vi.fn(async () => {
      calls.push("claim:fail");
    }),
    deleteAgent: vi.fn(async () => {
      calls.push("agent:delete");
    }),
  };

  const sandbox = {
    create: vi.fn(
      async (_options: unknown, onCreated: (id: string) => Promise<void>) => {
        calls.push("sandbox:create");
        await onCreated("sbx-1");
        return "sbx-1";
      },
    ),
    installCursorCli: vi.fn(
      async (_id: string, _path: string, _onOutput: unknown, _signal?: AbortSignal) => {
        calls.push("cli:install");
      },
    ),
    putClaimToken: vi.fn(async () => {
      calls.push("token:upload");
    }),
    startWorker: vi.fn(() => {
      calls.push("worker:start");
      return {
        completion: new Promise<number>(() => undefined),
        stop: () => calls.push("worker:stop"),
      };
    }),
    isWorkerReady: vi.fn(async () => true),
    listRegularOutputFiles: vi.fn(async () => ["hello.txt"]),
    downloadFile: vi.fn(async () => Buffer.from("hello")),
    terminate: vi.fn(async () => {
      calls.push("sandbox:terminate");
    }),
  };

  return { cursor, sandbox };
}

describe("provider-native fake lifecycle", () => {
  it("claims, connects, streams, downloads, and cleans up in order", async () => {
    const root = await temporaryRoot();
    const calls: string[] = [];
    const { cursor, sandbox } = fakes(calls);

    const completed = await runAgent(config, "make a file", {
      dependencies: { cursor, sandbox, runsRoot: root, installScriptPath: "/unused" },
    });

    expect(completed.result).toBe("completed");
    expect(
      await readFile(path.join(completed.runDirectory, "output/hello.txt"), "utf8"),
    ).toBe("hello");
    const state = await readState(root);
    expect(state.cursor_pool).toBe("sandbox");
    expect(state.phase).toBe("complete");
    expect(state.effective_egress_policy).toContain("api2.cursor.sh");
    expect(state.cleanup).toEqual({
      cursor_agent: "complete",
      cursor_claim: "complete",
      sandbox: "complete",
    });
    expect(calls.indexOf("claim:release")).toBeLessThan(calls.indexOf("agent:delete"));
    expect(calls.indexOf("agent:delete")).toBeLessThan(calls.indexOf("sandbox:terminate"));
    expect(calls).not.toContain("run:cancel");
  });

  it("records an ambiguous Cloud Agent creation for reconciliation", async () => {
    const root = await temporaryRoot();
    const calls: string[] = [];
    const { cursor, sandbox } = fakes(calls);
    cursor.createAgent.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(
      runAgent(config, "make a file", {
        dependencies: { cursor, sandbox, runsRoot: root, installScriptPath: "/unused" },
      }),
    ).rejects.toThrow("fetch failed");

    const state = await readState(root);
    expect(String(state.ambiguous_mutation)).toContain("Reconcile before retrying");
    expect(String(state.ambiguous_mutation)).toContain("/v1/agents?limit=20");
    expect(String(state.ambiguous_mutation)).toContain(String(state.started_at));
    expect(calls).not.toContain("sandbox:create");
  });

  it("reports the interrupt reason and still terminates the sandbox", async () => {
    const root = await temporaryRoot();
    const calls: string[] = [];
    const { cursor, sandbox } = fakes(calls);
    const controller = new AbortController();
    sandbox.installCursorCli.mockImplementationOnce(
      async (_id: string, _path: string, _onOutput: unknown, signal?: AbortSignal) => {
        setTimeout(() => controller.abort(new Error("Interrupted by SIGINT")), 10);
        await sleep(60_000, undefined, signal ? { signal } : undefined);
      },
    );

    await expect(
      runAgent(config, "make a file", {
        signal: controller.signal,
        dependencies: { cursor, sandbox, runsRoot: root, installScriptPath: "/unused" },
      }),
    ).rejects.toThrow("Interrupted by SIGINT");

    expect(calls).toContain("claim:fail");
    expect(calls).toContain("agent:delete");
    expect(calls.at(-1)).toBe("sandbox:terminate");
  });
});

describe("cleanupRun", () => {
  it("reports a hung sandbox termination instead of waiting forever", async () => {
    const root = await temporaryRoot();
    const store = await RunStore.create({ rootDirectory: root, pool: "sandbox", timeoutSeconds: 60 });
    await store.update({ sandbox_id: "sbx-1", cleanup: { sandbox: "pending" } });
    const { cursor } = fakes([]);

    const errors = await cleanupRun({
      cursor,
      sandbox: { terminate: () => new Promise<void>(() => undefined) },
      store,
      claimFailed: false,
      sandboxTimeoutMs: 20,
    });

    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("timed out");
    expect(store.snapshot().cleanup.sandbox).toBe("failed");
  });
});
