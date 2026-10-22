import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../../src/agent.js";
import type { Config } from "../../src/config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("provider-native fake lifecycle", () => {
  it("claims, connects, streams, downloads, and cleans up in order", async () => {
    const root = await mkdtemp(path.join(process.cwd(), ".test-lifecycle-"));
    temporaryDirectories.push(root);
    const calls: string[] = [];
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
          run: {
            id: "run-1",
            agentId: "bc-1",
            status: "CREATING" as const,
          },
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
        async (
          _options: unknown,
          onCreated: (id: string) => Promise<void>,
        ) => {
          calls.push("sandbox:create");
          await onCreated("sbx-1");
          return "sbx-1";
        },
      ),
      installCursorCli: vi.fn(async () => {
        calls.push("cli:install");
      }),
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

    const config: Config = {
      renderApiKey: "render-secret",
      renderWorkspaceId: "tea-1",
      cursorApiKey: "cursor-secret",
      cursorPool: "sandbox",
      cursorApiBaseUrl: "https://api.cursor.test",
      timeoutSeconds: 30,
    };
    const completed = await runAgent(config, "make a file", {
      dependencies: {
        cursor,
        sandbox,
        runsRoot: root,
        installScriptPath: "/unused",
      },
    });

    expect(completed.result).toBe("completed");
    expect(
      await readFile(path.join(completed.runDirectory, "output/hello.txt"), "utf8"),
    ).toBe("hello");
    const state = JSON.parse(
      await readFile(path.join(completed.runDirectory, "run.json"), "utf8"),
    ) as {
      cursor_pool: string;
      cleanup: Record<string, string>;
    };
    expect(state.cursor_pool).toBe("sandbox");
    expect(state.cleanup).toEqual({
      cursor_agent: "complete",
      cursor_claim: "complete",
      sandbox: "complete",
    });
    expect(calls.indexOf("claim:release")).toBeLessThan(
      calls.indexOf("agent:delete"),
    );
    expect(calls.indexOf("agent:delete")).toBeLessThan(
      calls.indexOf("sandbox:terminate"),
    );
    expect(calls).not.toContain("run:cancel");
  });
});
