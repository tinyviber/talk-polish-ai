import { describe, expect, test } from "bun:test";
import { acceptGroundedDailyStoryTitle, deriveStableDailyStoryTitle } from "./daily-story-title";

describe("Daily Story title grounding", () => {
  test("rejects a title that adds an event beyond the grounded basis", () => {
    const story = "今天去学校。";
    expect(acceptGroundedDailyStoryTitle(story, "今天发生火灾", "今天")).toBeNull();
    expect(deriveStableDailyStoryTitle(story)).toBe("今天去学校");
  });

  test.each([
    ["今天去北京", "今天", "今天去学校。"],
    ["今天有100人", "今天", "今天去学校。"],
    ["学校发生事故", "学校", "今天去学校。"],
  ])("rejects new place, number, or event content: %s", (title, basis, story) => {
    expect(acceptGroundedDailyStoryTitle(story, title, basis)).toBeNull();
  });

  test("accepts a concise title whose content is drawn from the story", () => {
    expect(acceptGroundedDailyStoryTitle("今天学校开了一个会议。", "学校会议", "学校")).toBe(
      "学校会议",
    );
  });
});
