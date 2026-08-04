import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const root = new URL(".", import.meta.url);

describe("frontend architecture boundaries", () => {
  test("practice state machine has no browser or React dependencies", async () => {
    const source = await readFile(new URL("state-machine.ts", root), "utf8");
    expect(source).not.toMatch(/react|IndexedDB|fetch|window|document|api/i);
    expect(source).not.toMatch(/type: ["']stage["']/);
  });
});
