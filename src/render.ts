import { readFile } from "node:fs/promises";
import { Render } from "@renderinc/sdk";
import {
  materializeSingleClaimToken,
  sandboxLaunchConfiguration,
} from "./launch-policy.js";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface WorkerProcess {
  completion: Promise<number>;
  stop: () => void;
}

export class RenderSandbox {
  private readonly sandboxes;

  constructor(options: { apiKey: string; workspaceId: string }) {
    this.sandboxes = new Render({
      token: options.apiKey,
      ownerId: options.workspaceId,
    }).experimental.sandboxes;
  }

  async create(
    options: {
      workerId: string;
      pool: string;
      timeoutSeconds: number;
    },
    onCreated: (sandboxId: string) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    const sandbox = await this.sandboxes.create(
      sandboxLaunchConfiguration(options),
    );
    await onCreated(sandbox.id);
    await this.waitUntilRunning(sandbox.id, signal);
    return sandbox.id;
  }

  async installCursorCli(
    sandboxId: string,
    localScriptPath: string,
    onOutput: (stream: "stdout" | "stderr", data: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const script = await readFile(localScriptPath);
    await this.sandboxes.upload(
      sandboxId,
      "/tmp/install-executor.sh",
      script,
    );
    const result = await this.execBuffered(
      sandboxId,
      "mkdir -p /workspace/output && chmod 0700 /tmp/install-executor.sh && /tmp/install-executor.sh",
      { ...(signal ? { signal } : {}), onOutput },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Cursor CLI installation failed with exit code ${result.exitCode}`,
      );
    }
  }

  async putClaimToken(
    sandboxId: string,
    token: string,
  ): Promise<void> {
    await materializeSingleClaimToken(this.sandboxes, sandboxId, token);
  }

  startWorker(
    sandboxId: string,
    options: {
      signal?: AbortSignal;
      onOutput: (stream: "stdout" | "stderr", data: string) => void;
    },
  ): WorkerProcess {
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });

    const command = [
      "exec agent worker",
      '--pool "$CURSOR_WORKER_POOL_NAME"',
      "--worker-dir /workspace",
      "--management-addr 127.0.0.1:8080",
      "--idle-release-timeout 60",
      "--auth-token-file /tmp/cursor-credentials/session-token",
      "start",
    ].join(" ");

    const completion = (async () => {
      const events = await this.sandboxes.exec(
        sandboxId,
        command,
        undefined,
        controller.signal,
      );
      let exitCode: number | undefined;
      for await (const event of events) {
        if (event.type === "output") {
          options.onOutput(event.stream, event.data);
        } else if (event.type === "exit") {
          exitCode = event.exit_code;
        }
      }
      return exitCode ?? 1;
    })().finally(() => {
      options.signal?.removeEventListener("abort", abort);
    });

    return {
      completion,
      stop: () => controller.abort(new Error("Worker stream stopped")),
    };
  }

  async isWorkerReady(
    sandboxId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const result = await this.execBuffered(
      sandboxId,
      "curl -fsS --max-time 2 http://127.0.0.1:8080/readyz",
      signal ? { signal } : {},
    );
    return result.exitCode === 0;
  }

  async execBuffered(
    sandboxId: string,
    command: string,
    options: {
      signal?: AbortSignal;
      onOutput?: (stream: "stdout" | "stderr", data: string) => void;
      maxBytes?: number;
    } = {},
  ): Promise<ExecResult> {
    const events = await this.sandboxes.exec(
      sandboxId,
      command,
      undefined,
      options.signal,
    );
    const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let truncated = false;
    let exitCode: number | undefined;

    for await (const event of events) {
      if (event.type === "output") {
        options.onOutput?.(event.stream, event.data);
        const bytes = Buffer.byteLength(event.data);
        if (capturedBytes < maxBytes) {
          const remaining = maxBytes - capturedBytes;
          const captured = Buffer.from(event.data).subarray(0, remaining).toString();
          if (event.stream === "stdout") stdout += captured;
          else stderr += captured;
          capturedBytes += Buffer.byteLength(captured);
          truncated ||= bytes > Buffer.byteLength(captured);
        } else {
          truncated = true;
        }
      } else if (event.type === "exit") {
        exitCode = event.exit_code;
      }
    }

    if (truncated) stderr += "\n[output truncated; stream fully drained]\n";
    return { exitCode: exitCode ?? 1, stdout, stderr };
  }

  async listRegularOutputFiles(
    sandboxId: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const result = await this.execBuffered(
      sandboxId,
      "if [ -d /workspace/output ]; then find /workspace/output -type f -printf '%P\\0'; fi",
      signal ? { signal } : {},
    );
    if (result.exitCode !== 0) {
      throw new Error(`Could not list /workspace/output: ${result.stderr.trim()}`);
    }
    return result.stdout.split("\0").filter(Boolean);
  }

  async downloadFile(
    sandboxId: string,
    remotePath: string,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const download = await this.sandboxes.download(
      sandboxId,
      remotePath,
      undefined,
      signal,
    );
    return download.data;
  }

  async terminate(sandboxId: string): Promise<void> {
    await this.sandboxes.terminate(sandboxId);
  }

  private async waitUntilRunning(
    sandboxId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    while (true) {
      signal?.throwIfAborted();
      const sandbox = await this.sandboxes.get(sandboxId);
      if (sandbox.status === "running") return;
      if (sandbox.status === "errored" || sandbox.status === "terminated") {
        throw new Error(`Render Sandbox ${sandboxId} is ${sandbox.status}`);
      }
      await sleep(1_500, signal);
    }
  }
}

async function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
