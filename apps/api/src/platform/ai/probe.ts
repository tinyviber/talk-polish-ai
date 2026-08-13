import { z } from "zod";

export type ProviderProbe = {
  probe(requestId?: string): Promise<void>;
};

/** Provider-neutral structured probe. It deliberately has no feature prompts. */
export const PROVIDER_PROBE_MAX_TOKENS = 384;
export const providerProbeSystemPrompt =
  "You are a provider connectivity probe. Return one short valid JSON object with a reply string.";
export const providerProbeSchema = z.object({ reply: z.string().min(1).max(900) }).strict();

export function providerProbeUserPrompt() {
  return 'Return {"reply":"ok"} now.';
}
