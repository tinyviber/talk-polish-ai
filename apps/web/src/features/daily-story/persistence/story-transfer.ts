import { CURRENT, LEASE_STORE, SESSION_STORE } from "./internal/database";
import { notifySession } from "./storage-events";
import { StoryImportError } from "./errors";
import {
  exportSessionRecord,
  importedReviewSidecar,
  importedSessionRecord,
  transferBytes,
} from "./internal/codecs";
import {
  MAX_STORY_TRANSFER_BYTES,
  MAX_STORY_TRANSFER_SESSIONS,
  leaseSchema,
  sessionSchema,
  storyExportEnvelopeSchema,
  type StoryExportEnvelope,
  type StoredSession,
} from "./internal/schemas";
import { sessionImportTransaction, setResult, transaction } from "./internal/transaction";
import { createConversationId } from "../types";
import { ensureDailyStorage } from "./story-session-repository";
import {
  deleteDailyStoryReview,
  readDailyStoryReview,
  writeDailyStoryReview,
} from "./story-review-repository";

export async function exportStorySessions(): Promise<string> {
  await ensureDailyStorage();
  const records = await transaction<unknown[]>(SESSION_STORE, "readonly", (tx) => {
    const request = tx.objectStore(SESSION_STORE).getAll();
    request.onsuccess = () => {
      setResult(tx, request.result as unknown[]);
    };
  });

  if (records.length > MAX_STORY_TRANSFER_SESSIONS) {
    throw new StoryImportError("对话数量超过导出上限。");
  }

  const sidecars = await Promise.all(
    records.map(async (record) => {
      const parsed = sessionSchema.safeParse(record);
      if (!parsed.success) return null;
      return readDailyStoryReview(
        parsed.data.id,
        parsed.data.revision,
        parsed.data.sessionInstanceId,
      );
    }),
  );
  let envelope: StoryExportEnvelope;
  try {
    envelope = storyExportEnvelopeSchema.parse({
      format: "kotoba-daily-story",
      version: 2,
      sessions: records.map((record, index) =>
        exportSessionRecord(record, sidecars[index] ?? null),
      ),
    });
  } catch {
    throw new StoryImportError(
      "本机存在无法导出的旧对话，未生成文件。请先打开并保存相关对话后重试。",
    );
  }
  const json = JSON.stringify(envelope);
  if (transferBytes(json) > MAX_STORY_TRANSFER_BYTES) {
    throw new StoryImportError("对话数据超过 10 MiB 导出上限。");
  }
  return json;
}

export async function importStorySessions(jsonText: string): Promise<{
  imported: number;
  migratedLegacy: boolean;
}> {
  if (typeof jsonText !== "string" || transferBytes(jsonText) > MAX_STORY_TRANSFER_BYTES) {
    throw new StoryImportError("导入文件超过 10 MiB 上限，未修改现有对话。");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    throw new StoryImportError("导入文件不是有效 JSON，未修改现有对话。");
  }
  const parsed = storyExportEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StoryImportError("导入文件格式或内容无效，未修改现有对话。");
  }
  if (parsed.data.sessions.length === 0) return { imported: 0, migratedLegacy: false };

  const imported = parsed.data.sessions.map(importedSessionRecord);
  const importedSidecars = parsed.data.sessions.map((session, index) =>
    importedReviewSidecar(session, imported[index]?.sessionInstanceId),
  );
  const result = await sessionImportTransaction<{
    importedIds: string[];
    migratedId?: string;
    migratedRevision?: number;
  }>((tx, setTransactionResult, abort) => {
    const sessionStore = tx.objectStore(SESSION_STORE);
    const leaseStore = tx.objectStore(LEASE_STORE);
    const sessionsRequest = sessionStore.getAll();
    const leaseRequest = leaseStore.get(CURRENT);
    let sessionsLoaded = false;
    let leaseLoaded = false;

    const validateAndWrite = () => {
      if (!sessionsLoaded || !leaseLoaded) return;
      try {
        const records = sessionsRequest.result as unknown[];
        const existingIds = new Set<string>();
        let legacyRaw: unknown;
        for (const record of records) {
          if (!record || typeof record !== "object") continue;
          const id = (record as { id?: unknown }).id;
          if (typeof id !== "string") continue;
          existingIds.add(id);
          if (id === CURRENT) legacyRaw = record;
        }

        let migratedRecord: StoredSession | undefined;
        let migratedId: string | undefined;
        if (legacyRaw !== undefined) {
          const legacy = sessionSchema.parse(legacyRaw);
          do {
            migratedId = createConversationId();
          } while (existingIds.has(migratedId));
          existingIds.add(migratedId);
          migratedRecord = { ...legacy, id: migratedId };
          if (leaseRequest.result !== undefined) leaseSchema.parse(leaseRequest.result);
        }

        for (const record of imported) {
          if (existingIds.has(record.id)) {
            throw new StoryImportError(`对话 ID 已存在：${record.id}`);
          }
          existingIds.add(record.id);
        }

        if (migratedRecord && migratedId) {
          sessionStore.add(migratedRecord);
          sessionStore.delete(CURRENT);
          const legacyLease =
            leaseRequest.result === undefined ? undefined : leaseSchema.parse(leaseRequest.result);
          if (legacyLease) {
            leaseStore.add({ ...legacyLease, id: migratedId });
            leaseStore.delete(CURRENT);
          }
        }
        for (const record of imported) sessionStore.add(record);
        setTransactionResult({
          importedIds: imported.map((record) => record.id),
          ...(migratedRecord && migratedId
            ? { migratedId, migratedRevision: migratedRecord.revision }
            : {}),
        });
      } catch (error) {
        abort(error);
      }
    };

    sessionsRequest.onsuccess = () => {
      sessionsLoaded = true;
      validateAndWrite();
    };
    leaseRequest.onsuccess = () => {
      leaseLoaded = true;
      validateAndWrite();
    };
  });

  if (result.migratedId && result.migratedRevision !== undefined) {
    notifySession(result.migratedId, result.migratedRevision);
  }
  for (const [index, id] of result.importedIds.entries()) {
    const sidecar = importedSidecars[index];
    if (
      sidecar &&
      (sidecar.score !== null || sidecar.comment !== null || sidecar.rubric !== null)
    ) {
      await writeDailyStoryReview(id, sidecar);
    } else {
      await deleteDailyStoryReview(id);
    }
    notifySession(id, 1);
  }
  return { imported: result.importedIds.length, migratedLegacy: !!result.migratedId };
}
