import { readdir, readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const featureRoot = new URL(".", import.meta.url);
const sourceRoot = new URL("../../", featureRoot);

async function sourceFiles(directory: URL): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const url = new URL(entry.name, directory);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(new URL(`${entry.name}/`, directory))));
    } else if (/\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.(?:ts|tsx)$/.test(entry.name)) {
      files.push(url.pathname);
    }
  }
  return files;
}

async function readSources(paths: string[]) {
  return Promise.all(paths.map(async (path) => [path, await readFile(path, "utf8")] as const));
}

describe("Daily Story architecture boundaries", () => {
  test("production code does not bypass the persistence adapters", async () => {
    const entries = await readSources(await sourceFiles(sourceRoot));
    const violations = entries.flatMap(([path, source]) => {
      const isCompatibilityFacade = path.endsWith("/features/daily-story/settings-repository.ts");
      const isPersistenceAdapter = path.includes("/features/daily-story/persistence/");
      if (isCompatibilityFacade || isPersistenceAdapter) return [];
      return /from\s+["'][^"']*\/settings-repository["']|from\s+["'][^"']*persistence\/(?:internal|(?:provider-settings|story-session|story-review|story-lease|story-transfer)-repository)["']/.test(
        source,
      )
        ? [path]
        : [];
    });

    expect(violations).toEqual([]);
  });

  test("UI and recording draft submission consume shared contracts, not controller exports", async () => {
    const paths = [
      new URL("../../components/daily-story/ui/Conversation.tsx", featureRoot).pathname,
      new URL("../../components/daily-story/ui/Review.tsx", featureRoot).pathname,
      new URL("recording-draft-submit.ts", featureRoot).pathname,
    ];
    const entries = await readSources(paths);
    const violations = entries.flatMap(([path, source]) =>
      /(?:from|import\()\s*["'][^"']*controller["']/.test(source) ? [path] : [],
    );

    expect(violations).toEqual([]);
    expect(await readFile(new URL("shared-types.ts", featureRoot), "utf8")).toMatch(
      /DAILY_STORY_TURN_MAX|DailyStoryCachedAudio|DailyStoryTranscribeResult/,
    );
  });

  test("controller keeps only compatibility re-exports for moved shared contracts", async () => {
    const source = await readFile(new URL("controller.ts", featureRoot), "utf8");

    expect(source).not.toMatch(/export\s+const\s+DAILY_STORY_TURN_MAX\s*=/);
    expect(source).not.toMatch(/export\s+type\s+DailyStory(?:CachedAudio|TranscribeResult)\s*=/);
    expect(source).toMatch(/export\s+\{\s*DAILY_STORY_TURN_MAX\s*\}\s+from\s+"\.\/shared-types"/);
    expect(source).toMatch(/export\s+type\s+\{[^}]*DailyStoryCachedAudio/);
    expect(source).toMatch(/export\s+type\s+\{[^}]*DailyStoryTranscribeResult/);
  });

  test("public persistence boundaries do not expose internal or test-only paths", async () => {
    const barrel = await readFile(new URL("persistence/index.ts", featureRoot), "utf8");
    const facade = await readFile(new URL("settings-repository.ts", featureRoot), "utf8");
    expect(barrel).not.toMatch(/persistence\/internal|from\s+["']\.\/internal/);
    expect(facade).not.toMatch(/persistence\/internal|persistence\/testing/);
  });

  test("shared contracts stay independent from persistence implementation", async () => {
    const source = await readFile(new URL("shared-types.ts", featureRoot), "utf8");
    expect(source).not.toMatch(/audio-outbox|persistence|indexedDB|controller/);
  });

  test("page composition consumes the application runtime adapter", async () => {
    const source = await readFile(
      new URL("../../components/daily-story/DailyStoryPage.tsx", featureRoot),
      "utf8",
    );
    expect(source).toMatch(/application\/daily-story-runtime/);
    expect(source).not.toMatch(/features\/daily-story\/controller/);
  });
});
