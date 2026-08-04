import type { Learner } from "@kotoba/contracts";
import { ApiError } from "../../http/errors";
import { learnerRepository, type LearnerRow } from "./repository";

type Row = LearnerRow;

const toLearner = (row: Row): Learner => ({
  id: row.id,
  deviceId: row.deviceId,
  lang: (row.lang as Learner["lang"]) ?? null,
  createdAt: row.createdAt.toISOString(),
});

/** Create or resume an anonymous, device-scoped learner profile. */
export async function upsertAnonymousLearner(
  deviceId: string,
  lang: Learner["lang"],
): Promise<Learner> {
  return toLearner(await learnerRepository.upsertAnonymous(deviceId, lang));
}

export async function requireLearner(learnerId: string): Promise<Learner> {
  const row = await learnerRepository.findById(learnerId);
  if (!row) throw ApiError.notFound("Learner");
  return toLearner(row);
}
