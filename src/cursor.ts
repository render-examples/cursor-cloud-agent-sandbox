import { setTimeout as sleep } from "node:timers/promises";

export type RunStatus =
  | "CREATING"
  | "RUNNING"
  | "FINISHED"
  | "ERROR"
  | "CANCELLED"
  | "EXPIRED";

export interface CursorRun {
  id: string;
  agentId: string;
  status: RunStatus;
  result?: string;
  durationMs?: number;
}

export interface CreatedAgent {
  agent: { id: string; latestRunId: string; status: string };
  run: CursorRun;
}

export interface PendingRequest {
  id: string;
  labels: Array<{ key: string; value: string }>;
  claimedWorkerId?: string;
}

export interface Claim {
  id: string;
  workerId: string;
  token: string;
  expiresAt: string;
}

export interface Worker {
  workerId: string;
  isInUse: boolean;
  activeBcId?: string;
  connectedAtMs: number;
}

export interface CursorSseEvent {
  id?: string;
  event: string;
  data: unknown;
}

export interface RunTerminal {
  run: CursorRun;
  source: "stream" | "get-run";
}

const TERMINAL = new Set<RunStatus>([
  "FINISHED",
  "ERROR",
  "CANCELLED",
  "EXPIRED",
]);

/** Bounds each cleanup request so sandbox termination is never blocked. */
export const CLEANUP_REQUEST_TIMEOUT_MS = 15_000;

export class CursorApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(`Cursor API ${status}${code ? ` ${code}` : ""}: ${message}`);
  }
}

export class CursorClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.cursor.com",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async assertAnyRepoPool(poolName: string, signal?: AbortSignal): Promise<void> {
    const response = await this.request<{
      pools: Array<{
        scope: string;
        poolName: string;
        repoOwner?: string;
        repoName?: string;
        repoUrl?: string;
      }>;
    }>("/v0/private-workers/pools?scope=team_pool&includeStale=false", {
      ...withSignal(signal),
    });
    const pool = response.pools.find((candidate) => candidate.poolName === poolName);
    if (!pool) {
      throw new Error(`Cursor Team Pool "${poolName}" was not found`);
    }
    if (pool.repoOwner || pool.repoName || pool.repoUrl) {
      throw new Error(
        `Cursor Team Pool "${poolName}" is repository-backed; configure an any-repository pool`,
      );
    }
  }

  /**
   * Not abortable: an abandoned request could create a Cloud Agent whose ID is
   * never recorded and therefore never deleted.
   */
  async createAgent(prompt: string, poolName: string): Promise<CreatedAgent> {
    return this.request<CreatedAgent>("/v1/agents", {
      method: "POST",
      body: JSON.stringify({
        prompt: { text: prompt },
        env: { type: "pool", name: poolName },
        mode: "agent",
      }),
    });
  }

  async listPendingRequests(
    poolName: string,
    signal?: AbortSignal,
  ): Promise<PendingRequest[]> {
    const requests: PendingRequest[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({
        pool: poolName,
        limit: "100",
        ...(pageToken ? { pageToken } : {}),
      });
      const result = await this.request<{
        requests: PendingRequest[];
        nextPageToken?: string;
      }>(`/v0/private-workers/pending-requests?${query}`, {
        ...withSignal(signal),
      });
      requests.push(...result.requests);
      pageToken = result.nextPageToken;
    } while (pageToken);
    return requests;
  }

  async waitForPendingRequest(
    agentId: string,
    poolName: string,
    signal?: AbortSignal,
  ): Promise<PendingRequest> {
    while (true) {
      const requests = await this.listPendingRequests(poolName, signal);
      const request = requests.find(
        (candidate) =>
          candidate.id === agentId &&
          candidate.labels.some(
            (label) => label.key === "pool" && label.value === poolName,
          ),
      );
      if (request) return request;
      await pause(1_000, signal);
    }
  }

  async claimPendingRequest(
    id: string,
    workerId: string,
    signal?: AbortSignal,
  ): Promise<Claim> {
    const claim = await this.request<Partial<Claim>>("/v0/private-workers/claim", {
      method: "POST",
      body: JSON.stringify({ id, workerId, sessionToken: true }),
      ...withSignal(signal),
    });
    if (!claim.token || !claim.expiresAt || claim.id !== id || claim.workerId !== workerId) {
      throw new Error("Cursor claim response did not include the requested session token");
    }
    return claim as Claim;
  }

  async getWorker(workerId: string, signal?: AbortSignal): Promise<Worker> {
    return this.request<Worker>(
      `/v0/private-workers/${encodeURIComponent(workerId)}`,
      { ...withSignal(signal) },
    );
  }

  async getRun(
    agentId: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<CursorRun> {
    return this.request<CursorRun>(
      `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
      { ...withSignal(signal) },
    );
  }

  async waitForRunTerminal(
    agentId: string,
    runId: string,
    options: {
      signal?: AbortSignal;
      lastEventId?: string;
      onEvent: (event: CursorSseEvent) => Promise<void> | void;
    },
  ): Promise<RunTerminal> {
    let lastEventId = options.lastEventId;
    let retryDelayMs = 500;

    while (true) {
      options.signal?.throwIfAborted();
      const headers: Record<string, string> = {
        Accept: "text/event-stream",
        Authorization: this.authorization(),
      };
      if (lastEventId) headers["Last-Event-ID"] = lastEventId;

      const response = await this.fetchImpl(
        `${this.baseUrl}/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/stream`,
        { headers, ...withSignal(options.signal) },
      );

      if (response.status === 410) {
        return this.pollTerminalRun(agentId, runId, options.signal);
      }
      if (!response.ok) {
        if (response.status >= 500 || response.status === 429) {
          await pause(retryDelayMs, options.signal);
          retryDelayMs = Math.min(retryDelayMs * 2, 5_000);
          continue;
        }
        throw await this.toError(response);
      }
      if (!response.body) throw new Error("Cursor run stream had no response body");

      retryDelayMs = 500;
      let sawDone = false;
      for await (const event of parseSse(response.body)) {
        if (event.id) lastEventId = event.id;
        await options.onEvent(event);
        if (event.event === "result") {
          const data = event.data as {
            runId?: string;
            status?: RunStatus;
            text?: string;
            durationMs?: number;
          };
          if (data.runId === runId && data.status && TERMINAL.has(data.status)) {
            return {
              source: "stream",
              run: {
                id: runId,
                agentId,
                status: data.status,
                ...(data.text === undefined ? {} : { result: data.text }),
                ...(data.durationMs === undefined
                  ? {}
                  : { durationMs: data.durationMs }),
              },
            };
          }
        }
        if (event.event === "done") sawDone = true;
      }

      const current = await this.getRun(agentId, runId, options.signal);
      if (TERMINAL.has(current.status)) {
        return { run: current, source: "get-run" };
      }
      if (sawDone) {
        return this.pollTerminalRun(agentId, runId, options.signal);
      }
      await pause(retryDelayMs, options.signal);
    }
  }

  async cancelRun(agentId: string, runId: string): Promise<void> {
    await this.request(
      `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/cancel`,
      { method: "POST", signal: AbortSignal.timeout(CLEANUP_REQUEST_TIMEOUT_MS) },
    );
  }

  async releaseClaim(agentId: string): Promise<void> {
    await this.request(
      `/v0/private-workers/claims/${encodeURIComponent(agentId)}/release`,
      { method: "POST", signal: AbortSignal.timeout(CLEANUP_REQUEST_TIMEOUT_MS) },
    );
  }

  async failClaim(agentId: string, message: string): Promise<void> {
    await this.request(
      `/v0/private-workers/claims/${encodeURIComponent(agentId)}/fail`,
      {
        method: "POST",
        body: JSON.stringify({ message: message.slice(0, 500) }),
        signal: AbortSignal.timeout(CLEANUP_REQUEST_TIMEOUT_MS),
      },
    );
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.request(`/v1/agents/${encodeURIComponent(agentId)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(CLEANUP_REQUEST_TIMEOUT_MS),
    });
  }

  private async pollTerminalRun(
    agentId: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<RunTerminal> {
    while (true) {
      const run = await this.getRun(agentId, runId, signal);
      if (TERMINAL.has(run.status)) return { run, source: "get-run" };
      await pause(1_000, signal);
    }
  }

  private async request<T = unknown>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: this.authorization(),
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) throw await this.toError(response);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private authorization(): string {
    return `Basic ${Buffer.from(`${this.apiKey}:`).toString("base64")}`;
  }

  private async toError(response: Response): Promise<CursorApiError> {
    let code: string | undefined;
    let message = response.statusText || "request failed";
    try {
      const body = (await response.json()) as {
        code?: string;
        error?: string;
        message?: string;
      };
      code = body.code;
      message = body.message ?? body.error ?? message;
    } catch {
      // Keep the status text; never echo an unstructured response body.
    }
    return new CursorApiError(response.status, code, message);
  }
}

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<CursorSseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let eventId: string | undefined;
  let dataLines: string[] = [];

  const emit = (): CursorSseEvent | undefined => {
    if (dataLines.length === 0) {
      eventName = "message";
      eventId = undefined;
      return undefined;
    }
    const raw = dataLines.join("\n");
    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      // SSE data is allowed to be plain text.
    }
    const result: CursorSseEvent = {
      event: eventName,
      data,
      ...(eventId === undefined ? {} : { id: eventId }),
    };
    eventName = "message";
    eventId = undefined;
    dataLines = [];
    return result;
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
    let lineEnd: number;
    while ((lineEnd = buffer.indexOf("\n")) >= 0) {
      const rawLine = buffer.slice(0, lineEnd);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      buffer = buffer.slice(lineEnd + 1);
      if (line === "") {
        const event = emit();
        if (event) yield event;
      } else if (!line.startsWith(":")) {
        const separator = line.indexOf(":");
        const field = separator < 0 ? line : line.slice(0, separator);
        let fieldValue = separator < 0 ? "" : line.slice(separator + 1);
        if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);
        if (field === "event") eventName = fieldValue;
        if (field === "id") eventId = fieldValue;
        if (field === "data") dataLines.push(fieldValue);
      }
    }
    if (done) break;
  }
  if (buffer) dataLines.push(buffer);
  const finalEvent = emit();
  if (finalEvent) yield finalEvent;
}

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL.has(status);
}

function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return sleep(milliseconds, undefined, signal ? { signal } : undefined);
}

function withSignal(signal?: AbortSignal): Pick<RequestInit, "signal"> | object {
  return signal ? { signal } : {};
}
