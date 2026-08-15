import {
  CURRENT,
  LEASE_STORE,
  SESSION_STORE,
  SYNC_META_STORE,
  SYNC_OUTBOX_STORE,
} from "./internal/database";
import { notifySession } from "./storage-events";
import { StoryImportError } from "./errors";
import {
  exportSessionRecord,
  fromStoredSession,
  importedReviewSidecar,
  importedSessionRecord,
  sameValue,
  sessionRecord,
  transferBytes,
} from "./internal/codecs";
import {
  MAX_STORY_TRANSFER_BYTES,
  MAX_STORY_TRANSFER_SESSIONS,
  leaseSchema,
  sessionSchema,
  storyExportEnvelopeSchema,
  syncMetaSchema,
  syncOutboxSchema,
  type StoryExportEnvelope,
  type StoredSession,
  type StoredSyncMeta,
} from "./internal/schemas";
import { sessionImportTransaction, setResult, transaction } from "./internal/transaction";
import { createConversationId, createId, type StorySession } from "../types";
import { ensureDailyStorage, readStorySession } from "./story-session-repository";
import {
  deleteDailyStoryReviewGuarded,
  isSuccessfulSidecarMutation,
  readDailyStoryReview,
  writeDailyStoryReviewGuarded,
} from "./story-review-repository";
import { clearReviewRepairMarker, toSyncConversation } from "./story-sync-repository";

const EXPORT_STABILITY_ERROR = "对话在导出期间发生变化，未生成文件。请稍后重试。";

function sameSessionVersion(left: StoredSession, right: StoredSession | StorySession) {
  return (
    left.revision === right.revision &&
    left.sessionInstanceId === right.sessionInstanceId &&
    left.updatedAt === right.updatedAt
  );
}

function effectiveReviewSidecar(session: StorySession) {
  if (!session.review) return null;
  return {
    score: session.review.score,
    comment: session.review.comment,
    overallFeedback: session.review.overallFeedback ?? null,
    rubric: session.review.rubric,
    sessionRevision: session.revision,
    ...(session.sessionInstanceId ? { sessionInstanceId: session.sessionInstanceId } : {}),
  };
}

async function readStableExportSnapshot(record: unknown) {
  const initial = sessionSchema.safeParse(record);
  if (!initial.success) throw new StoryImportError(EXPORT_STABILITY_ERROR);

  const first = await readStorySession(initial.data.id);
  if (!first || !sameSessionVersion(initial.data, first)) {
    throw new StoryImportError(EXPORT_STABILITY_ERROR);
  }

  const primaryRaw = await transaction<unknown | null>(SESSION_STORE, "readonly", (tx) => {
    const request = tx.objectStore(SESSION_STORE).get(initial.data.id);
    request.onsuccess = () => setResult(tx, (request.result as unknown) ?? null);
  });
  const primary = primaryRaw === null ? null : sessionSchema.safeParse(primaryRaw);
  const expectedPrimary = sessionRecord(first, initial.data.id);
  if (
    !primary?.success ||
    !sameSessionVersion(initial.data, primary.data) ||
    !sameValue(primary.data, expectedPrimary)
  ) {
    throw new StoryImportError(EXPORT_STABILITY_ERROR);
  }

  const second = await readStorySession(initial.data.id);
  if (!second || !sameSessionVersion(initial.data, second) || !sameValue(first, second)) {
    throw new StoryImportError(EXPORT_STABILITY_ERROR);
  }

  return {
    primary: expectedPrimary,
    sidecar: effectiveReviewSidecar(first),
  };
}

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

  let envelope: StoryExportEnvelope;
  try {
    const snapshots = await Promise.all(records.map(readStableExportSnapshot));
    envelope = storyExportEnvelopeSchema.parse({
      format: "kotoba-daily-story",
      version: 2,
      sessions: snapshots.map(({ primary, sidecar }) => exportSessionRecord(primary, sidecar)),
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
  const importedAggregates = parsed.data.sessions.map((session, index) => {
    const stored = imported[index];
    if (!stored) throw new StoryImportError("导入文件缺少对话记录，未修改现有对话。");
    const primary = fromStoredSession(stored);
    const sidecar = importedReviewSidecar(session, stored.sessionInstanceId);
    const review = primary.review
      ? {
          score: sidecar?.score ?? null,
          comment: sidecar?.comment ?? null,
          overallFeedback: sidecar?.overallFeedback ?? null,
          rubric: sidecar?.rubric ?? null,
          suggestions: primary.review.suggestions,
        }
      : undefined;
    return {
      session: review ? { ...primary, review } : primary,
      sidecar,
    };
  });

  const legacyRaw = await transaction<unknown | null>(SESSION_STORE, "readonly", (tx) => {
    const request = tx.objectStore(SESSION_STORE).get(CURRENT);
    request.onsuccess = () => setResult(tx, (request.result as unknown) ?? null);
  });
  let legacySidecar: Awaited<ReturnType<typeof readDailyStoryReview>> = null;
  if (legacyRaw !== null) {
    try {
      sessionSchema.parse(legacyRaw);
      legacySidecar = await readDailyStoryReview(CURRENT);
    } catch {
      // Do not migrate CURRENT when its primary or sidecar record cannot be
      // read and validated. The import must leave the existing data intact.
      throw new StoryImportError("无法安全迁移旧版当前对话，未修改现有对话。");
    }
  }

  type ImportSidecarJob = {
    conversationId: string;
    revision: number;
    sessionInstanceId: string;
    expectedPreviousSessionInstanceId?: string;
    sidecar: ReturnType<typeof importedReviewSidecar>;
    reviewRepair: NonNullable<StoredSyncMeta["reviewRepair"]>;
  };
  const result = await sessionImportTransaction<{
    importedIds: string[];
    migratedId?: string;
    migratedRevision?: number;
    sidecarJobs: ImportSidecarJob[];
  }>((tx, setTransactionResult, abort) => {
    const sessionStore = tx.objectStore(SESSION_STORE);
    const leaseStore = tx.objectStore(LEASE_STORE);
    const metaStore = tx.objectStore(SYNC_META_STORE);
    const outboxStore = tx.objectStore(SYNC_OUTBOX_STORE);
    const sessionsRequest = sessionStore.getAll();
    const leaseRequest = leaseStore.get(CURRENT);
    const metasRequest = metaStore.getAll();
    const outboxRequest = outboxStore.getAll();
    let sessionsLoaded = false;
    let leaseLoaded = false;
    let metasLoaded = false;
    let outboxLoaded = false;

    const validateAndWrite = () => {
      if (!sessionsLoaded || !leaseLoaded || !metasLoaded || !outboxLoaded) return;
      try {
        const records = sessionsRequest.result as unknown[];
        const existingIds = new Set<string>();
        const metas = (metasRequest.result as unknown[]).map((record) =>
          syncMetaSchema.parse(record),
        );
        const metaById = new Map(metas.map((meta) => [meta.conversationId, meta]));
        const outboxes = (outboxRequest.result as unknown[]).map((record) =>
          syncOutboxSchema.parse(record),
        );
        const outboxById = new Map(outboxes.map((outbox) => [outbox.conversationId, outbox]));
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
        let migratedAggregate: (typeof importedAggregates)[number]["session"] | undefined;
        if (legacyRaw !== undefined) {
          const legacy = sessionSchema.parse(legacyRaw);
          if (outboxById.has(CURRENT) || metaById.has(CURRENT)) {
            throw new StoryImportError("旧版当前对话存在未完成同步状态，未修改现有对话。");
          }
          do {
            migratedId = createConversationId();
          } while (
            existingIds.has(migratedId) ||
            metaById.has(migratedId) ||
            outboxById.has(migratedId)
          );
          existingIds.add(migratedId);
          migratedRecord = {
            ...legacy,
            id: migratedId,
            sessionInstanceId: legacy.sessionInstanceId ?? createConversationId(),
          };
          const migratedPrimary = fromStoredSession(migratedRecord);
          const migratedReview = migratedPrimary.review
            ? {
                score: legacySidecar?.score ?? null,
                comment: legacySidecar?.comment ?? null,
                overallFeedback: legacySidecar?.overallFeedback ?? null,
                rubric: legacySidecar?.rubric ?? null,
                suggestions: migratedPrimary.review.suggestions,
              }
            : undefined;
          migratedAggregate = migratedReview
            ? { ...migratedPrimary, review: migratedReview }
            : migratedPrimary;
          if (leaseRequest.result !== undefined) leaseSchema.parse(leaseRequest.result);
        }

        for (const record of imported) {
          const existingOutbox = outboxById.get(record.id);
          if (existingIds.has(record.id) || metaById.has(record.id)) {
            if (!(existingOutbox?.operation === "delete" && !existingIds.has(record.id))) {
              throw new StoryImportError(`对话 ID 已存在：${record.id}`);
            }
          }
          if (existingOutbox && existingOutbox.operation !== "delete") {
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
        const sidecarJobs: ImportSidecarJob[] = [];
        if (migratedRecord && migratedId && migratedAggregate) {
          const migratedSessionInstanceId = migratedAggregate.sessionInstanceId;
          if (!migratedSessionInstanceId) {
            throw new StoryImportError("旧版当前对话缺少安全身份，未修改现有对话。");
          }
          const reviewRepair = syncMetaSchema.parse({
            conversationId: migratedId,
            remoteRevision: null,
            localRevision: null,
            sessionInstanceId: migratedSessionInstanceId,
            reviewRepair: {
              operation: "upsert" as const,
              remoteRevision: null,
              sessionRevision: migratedAggregate.revision,
              sessionInstanceId: migratedSessionInstanceId,
              review: migratedAggregate.review ?? null,
            },
            updatedAt: new Date().toISOString(),
          }).reviewRepair!;
          metaStore.put(
            syncMetaSchema.parse({
              conversationId: migratedId,
              remoteRevision: null,
              localRevision: null,
              sessionInstanceId: migratedSessionInstanceId,
              reviewRepair,
              updatedAt: new Date().toISOString(),
            }),
          );
          outboxStore.put(
            syncOutboxSchema.parse({
              conversationId: migratedId,
              operation: "upsert",
              mutationId: createId("sync"),
              expectedRemoteRevision: null,
              localRevision: migratedAggregate.revision,
              payload: toSyncConversation(migratedAggregate, migratedId),
              queuedAt: new Date().toISOString(),
              attempts: 0,
              nextAttemptAt: 0,
            }),
          );
          sidecarJobs.push({
            conversationId: migratedId,
            revision: migratedAggregate.revision,
            sessionInstanceId: migratedSessionInstanceId,
            sidecar:
              legacySidecar && migratedAggregate.review
                ? {
                    score: legacySidecar.score,
                    comment: legacySidecar.comment,
                    overallFeedback: legacySidecar.overallFeedback ?? null,
                    rubric: legacySidecar.rubric,
                    sessionRevision: migratedAggregate.revision,
                    sessionInstanceId: migratedSessionInstanceId,
                  }
                : null,
            reviewRepair,
          });
        }
        for (const [index, record] of imported.entries()) {
          const aggregateEntry = importedAggregates[index];
          if (!aggregateEntry || !record.sessionInstanceId) {
            throw new StoryImportError("导入对话缺少安全身份，未修改现有对话。");
          }
          const aggregate = aggregateEntry.session;
          const existingMeta = metaById.get(record.id);
          const existingOutbox = outboxById.get(record.id);
          if (existingOutbox?.operation === "delete") outboxStore.delete(record.id);
          sessionStore.add(record);
          const reviewRepair = syncMetaSchema.parse({
            conversationId: record.id,
            remoteRevision: existingMeta?.remoteRevision ?? null,
            localRevision: existingMeta?.localRevision ?? null,
            sessionInstanceId: record.sessionInstanceId,
            reviewRepair: {
              operation: "upsert" as const,
              remoteRevision: existingMeta?.remoteRevision ?? null,
              sessionRevision: record.revision,
              sessionInstanceId: record.sessionInstanceId,
              review: aggregate.review ?? null,
            },
            updatedAt: new Date().toISOString(),
          }).reviewRepair!;
          metaStore.put(
            syncMetaSchema.parse({
              ...(existingMeta ?? {
                conversationId: record.id,
                remoteRevision: null,
                localRevision: null,
              }),
              conversationId: record.id,
              sessionInstanceId: record.sessionInstanceId,
              reviewRepair,
              updatedAt: new Date().toISOString(),
            }),
          );
          outboxStore.put(
            syncOutboxSchema.parse({
              conversationId: record.id,
              operation: "upsert",
              mutationId: createId("sync"),
              expectedRemoteRevision: existingMeta?.remoteRevision ?? null,
              localRevision: record.revision,
              payload: toSyncConversation(aggregate, record.id),
              queuedAt: new Date().toISOString(),
              attempts: 0,
              nextAttemptAt: 0,
            }),
          );
          sidecarJobs.push({
            conversationId: record.id,
            revision: record.revision,
            sessionInstanceId: record.sessionInstanceId,
            ...(existingOutbox?.operation === "delete" && existingMeta?.sessionInstanceId
              ? { expectedPreviousSessionInstanceId: existingMeta.sessionInstanceId }
              : {}),
            sidecar: aggregateEntry.sidecar,
            reviewRepair,
          });
        }
        setTransactionResult({
          importedIds: imported.map((record) => record.id),
          sidecarJobs,
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
    metasRequest.onsuccess = () => {
      metasLoaded = true;
      validateAndWrite();
    };
    outboxRequest.onsuccess = () => {
      outboxLoaded = true;
      validateAndWrite();
    };
  });

  if (result.migratedId && result.migratedRevision !== undefined) {
    notifySession(result.migratedId, result.migratedRevision);
  }
  for (const job of result.sidecarJobs) {
    const status = job.sidecar
      ? await writeDailyStoryReviewGuarded(
          job.conversationId,
          job.sidecar,
          job.expectedPreviousSessionInstanceId
            ? { expectedPreviousSessionInstanceId: job.expectedPreviousSessionInstanceId }
            : undefined,
        )
      : await deleteDailyStoryReviewGuarded(job.conversationId, {
          expectedSessionRevision: job.revision,
          expectedSessionInstanceId: job.sessionInstanceId,
          ...(job.expectedPreviousSessionInstanceId
            ? { expectedPreviousSessionInstanceId: job.expectedPreviousSessionInstanceId }
            : {}),
        });
    if (!isSuccessfulSidecarMutation(status)) {
      throw new StoryImportError("对话已导入，但 review 仍在等待本地修复，请稍后重试。");
    }
    await clearReviewRepairMarker(job.conversationId, job.reviewRepair);
    notifySession(job.conversationId, job.revision);
  }
  return { imported: result.importedIds.length, migratedLegacy: !!result.migratedId };
}
