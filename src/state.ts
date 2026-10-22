import { randomBytes } from "node:crypto";
import { appendFile, chmod, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type CleanupStatus = "pending" | "complete" | "failed" | "not-created";

export interface RunState {
  schema_version: 1;
  run_id: string;
  phase: string;
  started_at: string;
  deadline: string;
  cursor_pool: string;
  cursor_agent_id?: string;
  cursor_run_id?: string;
  cursor_worker_id?: string;
  cursor_claim_state?: "intent" | "claimed" | "connected" | "failed" | "released";
  sandbox_id?: string;
  last_event_id?: string;
  effective_egress_policy?: string[];
  ambiguous_mutation?: string;
  cleanup: {
    cursor_agent: CleanupStatus;
    cursor_claim: CleanupStatus;
    sandbox: CleanupStatus;
  };
}

export class RunStore {
  readonly directory: string;
  readonly outputDirectory: string;
  readonly eventsPath: string;
  readonly resultPath: string;
  readonly statePath: string;
  private state: RunState;
  private readonly secretValues: string[];

  private constructor(directory: string, state: RunState, secretValues: string[]) {
    this.directory = directory;
    this.outputDirectory = path.join(directory, "output");
    this.eventsPath = path.join(directory, "events.jsonl");
    this.resultPath = path.join(directory, "result.txt");
    this.statePath = path.join(directory, "run.json");
    this.state = state;
    this.secretValues = secretValues.filter(Boolean);
  }

  static async create(options: {
    rootDirectory?: string;
    pool: string;
    timeoutSeconds: number;
    secretValues?: string[];
  }): Promise<RunStore> {
    const runId = createRunId();
    const root = path.resolve(options.rootDirectory ?? "runs");
    const directory = path.join(root, runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);

    const now = new Date();
    const state: RunState = {
      schema_version: 1,
      run_id: runId,
      phase: "preflight",
      started_at: now.toISOString(),
      deadline: new Date(now.getTime() + options.timeoutSeconds * 1_000).toISOString(),
      cursor_pool: options.pool,
      cleanup: {
        cursor_agent: "not-created",
        cursor_claim: "not-created",
        sandbox: "not-created",
      },
    };
    const store = new RunStore(directory, state, options.secretValues ?? []);
    await store.writeState();
    await writeFile(store.eventsPath, "", { mode: 0o600, flag: "wx" });
    return store;
  }

  snapshot(): Readonly<RunState> {
    return structuredClone(this.state);
  }

  addSecret(value: string): void {
    if (value && !this.secretValues.includes(value)) {
      this.secretValues.push(value);
    }
  }

  async update(
    patch: Partial<Omit<RunState, "cleanup">> & {
      cleanup?: Partial<RunState["cleanup"]>;
    },
  ): Promise<void> {
    this.state = {
      ...this.state,
      ...patch,
      cleanup: {
        ...this.state.cleanup,
        ...patch.cleanup,
      },
    };
    await this.writeState();
  }

  async appendEvent(event: unknown): Promise<void> {
    const safe = redact(event, this.secretValues);
    await appendFile(this.eventsPath, `${JSON.stringify(safe)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async writeResult(result: string): Promise<void> {
    const safe = redactString(result, this.secretValues);
    await writeFile(this.resultPath, safe, { encoding: "utf8", mode: 0o600 });
  }

  private async writeState(): Promise<void> {
    const temporaryPath = `${this.statePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const payload = `${JSON.stringify(this.state, null, 2)}\n`;
    await writeFile(temporaryPath, payload, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.statePath);
    await chmod(this.statePath, 0o600);
  }
}

/**
 * Matches credential-named keys such as `token`, `sessionToken`, `apiKey`, and
 * `authorization`, but not counters such as `input_tokens` or `maxTokens`.
 */
const CREDENTIAL_KEY = /(token|secret|api_?key|authorization)$/i;

export function redact(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        CREDENTIAL_KEY.test(key) ? "[REDACTED]" : redact(item, secrets),
      ]),
    );
  }
  return value;
}

function redactString(value: string, secrets: string[]): string {
  return secrets.reduce(
    (result, secret) => result.split(secret).join("[REDACTED]"),
    value,
  );
}

function createRunId(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `run_${date}_${randomBytes(5).toString("hex")}`;
}
