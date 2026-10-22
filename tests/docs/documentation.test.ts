import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();

describe("documentation contract", () => {
  it("keeps documented environment names aligned with the example", async () => {
    const [example, tutorial] = await Promise.all([
      readFile(path.join(repositoryRoot, ".env.example"), "utf8"),
      readFile(path.join(repositoryRoot, "docs/tutorial.md"), "utf8"),
    ]);
    for (const name of [
      "RENDER_API_KEY",
      "RENDER_WORKSPACE_ID",
      "CURSOR_API_KEY",
      "CURSOR_POOL",
    ]) {
      expect(example).toContain(`${name}=`);
      expect(tutorial).toContain(name);
    }
  });

  it("documents the runnable command and stable next-step links", async () => {
    const tutorial = await readFile(
      path.join(repositoryRoot, "docs/tutorial.md"),
      "utf8",
    );
    expect(tutorial).toContain('npm run agent -- "');
    expect(tutorial).toContain(
      "https://cursor.com/docs/cloud-agent/self-hosted/pool.md",
    );
    expect(tutorial).toContain("https://render.com/docs/sandboxes");
  });

  it("pins the CLI artifact version and both Linux checksums", async () => {
    const installer = await readFile(
      path.join(repositoryRoot, "scripts/install-executor.sh"),
      "utf8",
    );
    expect(installer).toContain('CURSOR_AGENT_VERSION="2026.10.19-6bbf2c4"');
    expect(installer).toContain(
      "cf80cc18d8b33bf33e762353977ca1868cfc45290c92c0ffdcef83bb8b37b44f",
    );
    expect(installer).toContain(
      "71a90f12a8b8183a71442b7ed4037bddc1a0f88114ec4fb9ec92782acb8e7d84",
    );
    expect(installer).toContain("sha256sum --check");
  });
});
