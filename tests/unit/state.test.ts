import { readdir, readFile, rm, stat, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { redact, RunStore } from "../../src/state.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("RunStore", () => {
  it("writes state atomically with mode 0600 and no secret values", async () => {
    const root = await mkdtemp(path.join(process.cwd(), ".test-state-"));
    temporaryDirectories.push(root);
    const store = await RunStore.create({
      rootDirectory: root,
      pool: "sandbox",
      timeoutSeconds: 60,
      secretValues: ["super-secret"],
    });

    await store.update({
      cursor_agent_id: "bc-1",
      phase: "created",
    });
    await store.appendEvent({
      event: "tool_call",
      data: "super-secret",
      token: "another-secret",
    });

    const stateContents = await readFile(store.statePath, "utf8");
    expect(JSON.parse(stateContents).cursor_agent_id).toBe("bc-1");
    expect((await stat(store.statePath)).mode & 0o777).toBe(0o600);
    expect(await readdir(store.directory)).not.toContain(
      expect.stringContaining(".tmp"),
    );

    const events = await readFile(store.eventsPath, "utf8");
    expect(events).not.toContain("super-secret");
    expect(events).not.toContain("another-secret");
    expect(events).toContain("[REDACTED]");
  });
});

describe("redact", () => {
  it("redacts credential-shaped fields recursively", () => {
    expect(
      redact(
        { nested: { authorization: "Bearer x", ordinary: "safe" } },
        [],
      ),
    ).toEqual({
      nested: { authorization: "[REDACTED]", ordinary: "safe" },
    });
  });

  it("keeps usage counters whose names merely contain 'token'", () => {
    expect(
      redact(
        {
          usage: { input_tokens: 1200, output_tokens: 340 },
          maxTokens: 5,
          tokenizer: "o200k",
          sessionToken: "claim",
          apiKey: "key",
        },
        [],
      ),
    ).toEqual({
      usage: { input_tokens: 1200, output_tokens: 340 },
      maxTokens: 5,
      tokenizer: "o200k",
      sessionToken: "[REDACTED]",
      apiKey: "[REDACTED]",
    });
  });
});
