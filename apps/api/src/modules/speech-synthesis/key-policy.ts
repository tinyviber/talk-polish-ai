import { createHash } from "node:crypto";
import type { Lang } from "@kotoba/contracts";

export function synthesisObjectKey(input: {
  scope: string;
  purpose: string;
  model: string;
  voice: string;
  lang: Lang;
  format: string;
  text: string;
}) {
  const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return `tts/${input.scope}/${input.purpose}/${input.model}/${input.voice}/${input.lang}/${input.format}/${hash}.${input.format}`.replace(
    /[^a-zA-Z0-9._/-]/g,
    "_",
  );
}
