import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface OutputSandbox {
  listRegularOutputFiles(
    sandboxId: string,
    signal?: AbortSignal,
  ): Promise<string[]>;
  downloadFile(
    sandboxId: string,
    remotePath: string,
    signal?: AbortSignal,
  ): Promise<Buffer>;
}

export async function collectOutputs(options: {
  sandbox: OutputSandbox;
  sandboxId: string;
  destination: string;
  forbiddenValues?: string[];
  signal?: AbortSignal;
}): Promise<string[]> {
  const files = await options.sandbox.listRegularOutputFiles(
    options.sandboxId,
    options.signal,
  );
  const copied: string[] = [];

  for (const relativePath of files) {
    const safeRelativePath = validateRelativePath(relativePath);
    const remotePath = `/workspace/output/${safeRelativePath}`;
    const localPath = path.join(
      options.destination,
      ...safeRelativePath.split("/"),
    );
    await mkdir(path.dirname(localPath), { recursive: true, mode: 0o700 });
    const bytes = await options.sandbox.downloadFile(
      options.sandboxId,
      remotePath,
      options.signal,
    );
    for (const secret of options.forbiddenValues ?? []) {
      if (secret && bytes.includes(Buffer.from(secret))) {
        throw new Error(
          `Refusing to save ${safeRelativePath}: it contains configured credential material`,
        );
      }
    }
    await writeFile(localPath, bytes, { mode: 0o600 });
    copied.push(safeRelativePath);
  }
  return copied;
}

export function validateRelativePath(candidate: string): string {
  if (!candidate || candidate.includes("\0") || candidate.startsWith("/")) {
    throw new Error(`Unsafe sandbox output path: ${JSON.stringify(candidate)}`);
  }
  const normalized = path.posix.normalize(candidate);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized !== candidate
  ) {
    throw new Error(`Unsafe sandbox output path: ${JSON.stringify(candidate)}`);
  }
  return normalized;
}
