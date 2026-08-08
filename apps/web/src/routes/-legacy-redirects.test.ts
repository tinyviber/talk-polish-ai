import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const root = new URL(".", import.meta.url);

describe("retired MVP routes", () => {
  test("keep old URLs as redirects without importing legacy UI", async () => {
    const source = await readFile(new URL("$legacy.tsx", root), "utf8");
    expect(source).toMatch(/practice.*progress.*saved/s);
    expect(source).toMatch(/redirect\(\{ to: "\/" \}\)/);
    expect(source).not.toMatch(/@\/components\/practice|@\/features\/practice|@\/lib\/practice/);
  });
});
