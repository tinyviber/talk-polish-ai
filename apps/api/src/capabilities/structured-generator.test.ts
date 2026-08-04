import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createStructuredGenerator } from "./structured-generator";
import type { TextModel } from "./text-model";

const schema = z.object({ answer: z.string() });

function fakeModel(contents: string[]): TextModel {
  return {
    name: "fake-text",
    async generate() {
      const content = contents.shift() ?? "";
      return { content, provider: "fake-text", model: "test" };
    },
  };
}

describe("StructuredGenerator", () => {
  test("parses fenced JSON", async () => {
    const result = await createStructuredGenerator(
      fakeModel(['```json\n{"answer":"ok"}\n```']),
    ).generate({
      messages: [{ role: "user", content: "answer" }],
      schema,
    });
    expect(result.value.answer).toBe("ok");
    expect(result.repaired).toBe(false);
  });

  test("repairs one invalid response then validates", async () => {
    const result = await createStructuredGenerator(
      fakeModel(["{bad", '{"answer":"fixed"}']),
    ).generate({
      messages: [{ role: "user", content: "answer" }],
      schema,
    });
    expect(result.value.answer).toBe("fixed");
    expect(result.repaired).toBe(true);
  });

  test("fails after repair exhaustion", async () => {
    await expect(
      createStructuredGenerator(fakeModel(["{bad", "still bad"])).generate({
        messages: [{ role: "user", content: "answer" }],
        schema,
      }),
    ).rejects.toMatchObject({ code: "structured_generation" });
  });
});
