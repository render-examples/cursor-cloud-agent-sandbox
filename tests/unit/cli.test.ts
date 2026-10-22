import { describe, expect, it } from "vitest";
import { parseArguments } from "../../src/cli.js";

describe("parseArguments", () => {
  it("joins prompt words and parses the documented flags", () => {
    expect(
      parseArguments(["make", "a", "file", "--timeout", "90", "--output", "./artifacts"]),
    ).toEqual({ prompt: "make a file", timeoutSeconds: 90, outputDirectory: "./artifacts" });
  });

  it.each(["12.5", "0", "-1", "abc"])("rejects --timeout %s", (value) => {
    expect(() => parseArguments(["prompt", "--timeout", value])).toThrow("positive integer");
  });
});
