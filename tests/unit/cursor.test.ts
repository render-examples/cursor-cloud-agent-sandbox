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
