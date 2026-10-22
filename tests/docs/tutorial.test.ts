import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const repository = "cursor-cloud-agent-sandbox";
const stableRoute = "https://render.com/docs/sandboxes/hosted-agents/cursor";
const siblingRoutes = [
  "https://render.com/docs/sandboxes/hosted-agents/openai",
  "https://render.com/docs/sandboxes/hosted-agents/claude-managed-agents",
];

async function sources(): Promise<string> {
  const files = await readdir(join(root, "src"));
  const contents = await Promise.all(
    files.filter((file) => file.endsWith(".ts")).map((file) => readFile(join(root, "src", file), "utf8")),
  );
  return contents.join("\n");
}

function fencedBlockAfter(markdown: string, marker: string, language: string): string {
  const start = markdown.indexOf(marker);
  expect(start, `missing "${marker}"`).toBeGreaterThanOrEqual(0);
  const match = markdown.slice(start).match(new RegExp("```" + language + "\\n([\\s\\S]*?)```"));
  expect(match, `missing ${language} block after "${marker}"`).not.toBeNull();
  return match![1]!;
}

describe("tutorial contract", async () => {
  const tutorial = await readFile(join(root, "docs", "tutorial.md"), "utf8");
  const readme = await readFile(join(root, "README.md"), "utf8");
  const source = await sources();

  it("links source files by pinned URLs that exist in this repository", () => {
    expect(tutorial).not.toMatch(/\]\(\.\.?\//);
    const prefix = `https://github.com/render-examples/${repository}/blob/v1.0.0/`;
    const linked = [...tutorial.matchAll(new RegExp(`${prefix}([^)\\s]+)`, "g"))].map((match) => match[1]!);
    expect(linked.length).toBeGreaterThan(0);
    for (const path of linked) expect(existsSync(join(root, path)), path).toBe(true);
  });

  it("shows only output labels the runner prints", () => {
    const output = fencedBlockAfter(tutorial, "You should see", "text");
    const labels = output
      .split("\n")
      .map((line) => line.match(/^([a-z][a-z:]*)\s+\S/)?.[1])
      .filter((label): label is string => Boolean(label));
    expect(labels).toEqual(expect.arrayContaining(["preflight", "provision", "result", "outputs", "cleanup"]));
    for (const label of labels) {
      expect(source, `label "${label}"`).toMatch(new RegExp(`["\`]${label}[\\s"]`));
    }
  });

  it("explains functions that exist in the source", () => {
    const excerpt = fencedBlockAfter(tutorial, "## 4.", "ts");
    const tableRows = tutorial.slice(tutorial.indexOf("Here is what the key pieces do"));
    const called = [
      ...[...excerpt.matchAll(/(?:\.|\b)([a-zA-Z]+)\(/g)].map((match) => match[1]!),
      ...[...tableRows.matchAll(/^\| `(?:[a-z]+\.)?([a-zA-Z]+)\(\)`/gm)].map((match) => match[1]!),
    ];
    expect(called.length).toBeGreaterThan(5);
    for (const name of new Set(called)) {
      expect(source, `function ${name}`).toMatch(new RegExp(`\\b${name}\\(`));
    }
  });

  it("links the stable route and the sibling tutorials", () => {
    expect(readme).toContain(stableRoute);
    for (const route of siblingRoutes) expect(tutorial).toContain(route);
    expect(tutorial).toContain("Node.js](https://nodejs.org/) 22");
  });
});
