import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectOutputs,
  validateRelativePath,
} from "../../src/outputs.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("collectOutputs", () => {
  it("preserves relative paths and downloads regular files", async () => {
    const destination = await mkdtemp(
      path.join(process.cwd(), ".test-output-"),
    );
    temporaryDirectories.push(destination);
    const sandbox = {
      listRegularOutputFiles: vi.fn().mockResolvedValue(["src/index.ts"]),
      downloadFile: vi.fn().mockResolvedValue(Buffer.from("console.log('ok')")),
    };

    const copied = await collectOutputs({
      sandbox,
      sandboxId: "sbx-1",
      destination,
    });

    expect(copied).toEqual(["src/index.ts"]);
    expect(
      await readFile(path.join(destination, "src/index.ts"), "utf8"),
    ).toBe("console.log('ok')");
    expect(sandbox.downloadFile).toHaveBeenCalledWith(
      "sbx-1",
      "/workspace/output/src/index.ts",
      undefined,
    );
  });

  it("refuses to persist known credential material", async () => {
    const destination = await mkdtemp(
      path.join(process.cwd(), ".test-output-"),
    );
    temporaryDirectories.push(destination);
    const sandbox = {
      listRegularOutputFiles: vi.fn().mockResolvedValue(["leak.txt"]),
      downloadFile: vi.fn().mockResolvedValue(Buffer.from("token-value")),
    };

    await expect(
      collectOutputs({
        sandbox,
        sandboxId: "sbx-1",
        destination,
        forbiddenValues: ["token-value"],
      }),
    ).rejects.toThrow("credential material");
  });
});

describe("validateRelativePath", () => {
  it.each(["../secret", "/etc/passwd", "a/../secret", ""])(
    "rejects unsafe path %j",
    (candidate) => {
      expect(() => validateRelativePath(candidate)).toThrow("Unsafe");
    },
  );
});
