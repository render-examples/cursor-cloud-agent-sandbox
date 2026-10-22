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
});
