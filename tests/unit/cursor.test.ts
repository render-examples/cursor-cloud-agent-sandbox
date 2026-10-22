import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { CursorClient, parseSse } from "../../src/cursor.js";

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("Cursor run SSE", () => {
  it("parses native event names, ids, and JSON data", async () => {
    const events = [];
    for await (const event of parseSse(
      stream(
        'id: evt-1\nevent: tool_call\ndata: {"name":"read_file","status":"running"}\n\n',
      ),
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      {
        id: "evt-1",
        event: "tool_call",
        data: { name: "read_file", status: "running" },
      },
    ]);
  });

  it("falls back to Get A Run after stream retention expires", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("", { status: 410, statusText: "Gone" }),
      )
      .mockResolvedValueOnce(
        Response.json({
          id: "run-1",
          agentId: "bc-1",
          status: "FINISHED",
          result: "done",
        }),
      );
    const client = new CursorClient(
      "service-account-key",
      "https://api.cursor.test",
      fetchMock,
    );

    const terminal = await client.waitForRunTerminal("bc-1", "run-1", {
      lastEventId: "evt-9",
      onEvent: vi.fn(),
    });

    expect(terminal.source).toBe("get-run");
    expect(terminal.run.result).toBe("done");
    const firstHeaders = new Headers(fetchMock.mock.calls[0]![1]?.headers);
    expect(firstHeaders.get("Last-Event-ID")).toBe("evt-9");
    expect(firstHeaders.get("Authorization")).toMatch(/^Basic /);
  });
});

describe("Cursor polling and cleanup requests", () => {
  it("does not accumulate abort listeners while polling", async () => {
    let calls = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      calls += 1;
      return Response.json({
        requests:
          calls < 3 ? [] : [{ id: "bc-1", labels: [{ key: "pool", value: "sandbox" }] }],
      });
    });
    const client = new CursorClient("key", "https://api.cursor.test", fetchMock);
    const controller = new AbortController();

    await expect(
      client.waitForPendingRequest("bc-1", "sandbox", controller.signal),
    ).resolves.toMatchObject({ id: "bc-1" });
    expect(calls).toBe(3);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("bounds every cleanup request with a timeout signal", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(null, { status: 204 }));
    const client = new CursorClient("key", "https://api.cursor.test", fetchMock);

    await client.cancelRun("bc-1", "run-1");
    await client.releaseClaim("bc-1");
    await client.failClaim("bc-1", "failed");
    await client.deleteAgent("bc-1");

    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("does not attach the run signal to Cloud Agent creation", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        agent: { id: "bc-1", latestRunId: "run-1", status: "ACTIVE" },
        run: { id: "run-1", agentId: "bc-1", status: "CREATING" },
      }),
    );
    const client = new CursorClient("key", "https://api.cursor.test", fetchMock);
    await client.createAgent("prompt", "sandbox");
    expect(fetchMock.mock.calls[0]![1]?.signal).toBeUndefined();
  });
});

describe("Cursor pool validation", () => {
  it("rejects a repository-backed pool", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        pools: [
          {
            scope: "team",
            poolName: "sandbox",
            repoOwner: "acme",
            repoName: "repo",
          },
        ],
      }),
    );
    const client = new CursorClient("key", "https://api.cursor.test", fetchMock);
    await expect(client.assertAnyRepoPool("sandbox")).rejects.toThrow(
      "repository-backed",
    );
  });
});
