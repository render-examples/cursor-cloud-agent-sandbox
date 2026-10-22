/**
 * Compatibility seam for Render's hostname egress and intended credential
 * broker. @renderinc/sdk 1.3.0 exposes an `allow-list` network policy, but no
 * Sandbox credential-broker primitive.
 *
 * The single-claim Cursor token is therefore materialized as a 0600 file after
 * creation. Replace only this module when brokered files become public.
 */

/** Hosts `agent worker` needs while it serves the claimed Cloud Agent. */
export const RUNTIME_DESTINATIONS = [
  "api2.cursor.sh",
  "api2direct.cursor.sh",
  "agent-stores.s3.us-east-1.amazonaws.com",
  "cloud-agent-artifacts.s3.us-east-1.amazonaws.com",
  "cursor.com",
] as const;

/**
 * Hosts used only to download the pinned CLI release. The SDK cannot narrow a
 * policy after creation, so they stay allowed for this short-lived run.
 */
export const INSTALL_DESTINATIONS = ["downloads.cursor.com"] as const;

export const EGRESS_DESTINATIONS = [...RUNTIME_DESTINATIONS, ...INSTALL_DESTINATIONS];

export const PUBLIC_SDK_EGRESS_POLICY = {
  type: "allow-list",
  rules: EGRESS_DESTINATIONS.map((domain) => ({
    domain,
    protocol: "https" as const,
  })),
} as const;

export interface SandboxFileApi {
  upload(
    sandboxId: string,
    path: string,
    data: Buffer | Uint8Array | string,
  ): Promise<void>;
  exec(
    sandboxId: string,
    command: string,
  ): Promise<
    AsyncIterable<
      | { type: "output"; stream: "stdout" | "stderr"; data: string }
      | { type: "exit"; exit_code: number }
    >
  >;
}

export function sandboxLaunchConfiguration(options: {
  workerId: string;
  pool: string;
  timeoutSeconds: number;
}) {
  return {
    timeoutSeconds: options.timeoutSeconds,
    networkPolicy: PUBLIC_SDK_EGRESS_POLICY,
    env: {
      CURSOR_AGENT_WORKER_ID: options.workerId,
      CURSOR_WORKER_POOL_NAME: options.pool,
      CURSOR_DISABLE_AUTO_UPDATE: "1",
      PATH: "/tmp/cursor-home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: "/tmp/cursor-home",
    },
  };
}

export async function materializeSingleClaimToken(
  sandboxes: SandboxFileApi,
  sandboxId: string,
  token: string,
): Promise<void> {
  await requireSuccessfulExec(
    sandboxes,
    sandboxId,
    "install -d -m 0700 /tmp/cursor-credentials",
  );
  await sandboxes.upload(
    sandboxId,
    "/tmp/cursor-credentials/session-token",
    Buffer.from(token, "utf8"),
  );
  await requireSuccessfulExec(
    sandboxes,
    sandboxId,
    "chmod 0600 /tmp/cursor-credentials/session-token",
  );
}

async function requireSuccessfulExec(
  sandboxes: SandboxFileApi,
  sandboxId: string,
  command: string,
): Promise<void> {
  const events = await sandboxes.exec(sandboxId, command);
  let exitCode: number | undefined;
  for await (const event of events) {
    if (event.type === "exit") exitCode = event.exit_code;
  }
  if (exitCode !== 0) {
    throw new Error(`Sandbox setup command failed with exit code ${exitCode ?? "unknown"}`);
  }
}
