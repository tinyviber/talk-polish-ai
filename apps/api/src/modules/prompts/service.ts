import type { Lang, Prompt } from "@kotoba/contracts";
import { ApiError } from "../../http/errors";
import { promptRepository, type PromptRow } from "./repository";

type Row = PromptRow;

const toPrompt = (row: Row): Prompt => ({
  id: row.id,
  lang: row.lang as Lang,
  scenario: row.scenario,
  situation: row.situation,
  question: row.question,
  ...(row.questionTranslation ? { questionTranslation: row.questionTranslation } : {}),
  hints: row.hints,
  seconds: row.seconds,
});

export async function listPrompts(lang?: Lang): Promise<Prompt[]> {
  const rows = await promptRepository.list(lang);
  return rows.map(toPrompt);
}

export async function requirePrompt(id: string): Promise<Prompt> {
  const row = await promptRepository.findById(id);
  if (!row) throw ApiError.notFound("Prompt");
  return toPrompt(row);
}
