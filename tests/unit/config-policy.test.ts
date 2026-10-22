import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import {
  materializeSingleClaimToken,
  PUBLIC_SDK_EGRESS_POLICY,
  sandboxLaunchConfiguration,
} from "../../src/launch-policy.js";

describe("configuration", () => {
  it("reports every missing required variable", () => {
    expect(() => loadConfig({})).toThrow(
      "RENDER_API_KEY, RENDER_WORKSPACE_ID, CURSOR_API_KEY, CURSOR_POOL",
    );
  });

  it("keeps the service-account key out of sandbox creation", () => {
    const launch = sandboxLaunchConfiguration({
      workerId: "pw-stable",
      pool: "sandbox",
      timeoutSeconds: 600,
    });
    expect(launch.networkPolicy).toBe(PUBLIC_SDK_EGRESS_POLICY);
    expect(launch.env).toMatchObject({
      CURSOR_AGENT_WORKER_ID: "pw-stable",
      CURSOR_WORKER_POOL_NAME: "sandbox",
      CURSOR_DISABLE_AUTO_UPDATE: "1",
      HOME: "/tmp/cursor-home",
    });
    expect(JSON.stringify(launch)).not.toContain("CURSOR_API_KEY");
  });
});

describe("claim credential materialization", () => {
  it("uploads the token as bytes instead of placing it in argv", async () => {
    const commands: string[] = [];
    const api = {
      upload: vi.fn().mockResolvedValue(undefined),
      exec: vi.fn(async (_sandboxId: string, command: string) => {
        commands.push(command);
        return (async function* () {
          yield { type: "exit" as const, exit_code: 0 };
        })();
      }),
    };

    await materializeSingleClaimToken(api, "sbx-1", "claim-token");

    expect(api.upload).toHaveBeenCalledWith(
      "sbx-1",
      "/tmp/cursor-credentials/session-token",
      Buffer.from("claim-token"),
    );
    expect(commands.join("\n")).not.toContain("claim-token");
  });
});
