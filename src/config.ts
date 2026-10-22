import path from "node:path";

export interface Config {
  renderApiKey: string;
  renderWorkspaceId: string;
  cursorApiKey: string;
  cursorPool: string;
  cursorApiBaseUrl: string;
  timeoutSeconds: number;
  outputDirectory?: string;
}

const REQUIRED_ENV = [
  "RENDER_API_KEY",
  "RENDER_WORKSPACE_ID",
  "CURSOR_API_KEY",
  "CURSOR_POOL",
] as const;

export function loadConfig(
  env: NodeJS.ProcessEnv,
  overrides: { timeoutSeconds?: number; outputDirectory?: string } = {},
): Config {
  const missing = REQUIRED_ENV.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. Copy .env.example to .env and fill them in.`,
    );
  }

  const configuredTimeout = parsePositiveInteger(
    env.AGENT_TIMEOUT_SECONDS ?? "600",
    "AGENT_TIMEOUT_SECONDS",
  );
  const timeoutSeconds =
    overrides.timeoutSeconds === undefined
      ? configuredTimeout
      : parsePositiveInteger(String(overrides.timeoutSeconds), "--timeout");

  const cursorApiBaseUrl = (
    env.CURSOR_API_BASE_URL ?? "https://api.cursor.com"
  ).replace(/\/+$/, "");
  const parsedBaseUrl = new URL(cursorApiBaseUrl);
  if (parsedBaseUrl.protocol !== "https:" && parsedBaseUrl.hostname !== "localhost") {
    throw new Error("CURSOR_API_BASE_URL must use HTTPS");
  }

  const outputDirectory = overrides.outputDirectory
    ? path.resolve(overrides.outputDirectory)
    : undefined;

  return {
    renderApiKey: env.RENDER_API_KEY!.trim(),
    renderWorkspaceId: env.RENDER_WORKSPACE_ID!.trim(),
    cursorApiKey: env.CURSOR_API_KEY!.trim(),
    cursorPool: env.CURSOR_POOL!.trim(),
    cursorApiBaseUrl,
    timeoutSeconds,
    ...(outputDirectory ? { outputDirectory } : {}),
  };
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
