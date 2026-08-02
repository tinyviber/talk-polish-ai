import { describe, expect, test } from "bun:test";
import {
  issueAudioReference,
  resolveAudioReference,
  type AudioReference,
  type AudioReferenceStore,
} from "./audio-references";

function testStore(): AudioReferenceStore {
  const references = new Map<string, AudioReference>();
  return {
    async create(reference) {
      references.set(reference.id, reference);
    },
    async resolve(id, learnerId, now) {
      const reference = references.get(id);
      return reference && reference.learnerId === learnerId && reference.expiresAt > now
        ? reference
        : null;
    },
  };
}

describe("scoped audio references", () => {
  test("uses opaque owner-scoped references", async () => {
    const store = testStore();
    const reference = await issueAudioReference(
      "lnr_owner",
      "local://tts/lnr_owner/answer.mp3",
      "audio/mpeg",
      store,
    );
    expect(reference).not.toContain("local://");
    expect((await resolveAudioReference(reference, "lnr_owner", store))?.mimeType).toBe(
      "audio/mpeg",
    );
    expect(await resolveAudioReference(reference, "lnr_other", store)).toBeNull();
  });

  test("rejects traversal and unsupported storage references", async () => {
    await expect(
      issueAudioReference("lnr_owner", "local://tts/../secret.mp3", "audio/mpeg"),
    ).rejects.toThrow("invalid storage key");
    await expect(
      issueAudioReference("lnr_owner", "https://public.example/audio.mp3", "audio/mpeg"),
    ).rejects.toThrow("invalid storage key");
  });
});
