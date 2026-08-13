import { CURRENT, SETTINGS_STORE } from "./internal/database";
import { notifySettings } from "./storage-events";
import { DailyStorageError } from "./errors";
import {
  fromStoredSettings,
  normalizeProviderForStorage,
  sameValue,
  settingsRecord,
  validateProviderForStorage,
} from "./internal/codecs";
import { settingsSchema } from "./internal/schemas";
import { setResult, transaction } from "./internal/transaction";
import type {
  AsrProvider,
  ChatProvider,
  DailyCapability,
  ProviderSettings,
  TtsProvider,
} from "../types";

export async function readProviderSettings(): Promise<ProviderSettings> {
  const result = await transaction<ProviderSettings>(SETTINGS_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(SETTINGS_STORE);
    const request = store.get(CURRENT);
    request.onsuccess = () => {
      const record = request.result as unknown;
      const defaultSettings: ProviderSettings = {
        schemaVersion: 1,
        revision: 0,
        updatedAt: new Date(0).toISOString(),
      };
      if (record === undefined) {
        setResult(tx, defaultSettings);
        return;
      }
      const parsed = settingsSchema.parse(record);
      const normalized = fromStoredSettings(parsed);
      const canonical = settingsRecord(normalized);
      if (sameValue(parsed, canonical)) {
        setResult(tx, normalized);
        return;
      }
      const write = store.put(canonical);
      write.onsuccess = () => setResult(tx, normalized);
    };
  });
  return result;
}

export async function writeProviderSettings(
  updater: (
    current: ProviderSettings,
  ) => Omit<ProviderSettings, "schemaVersion" | "revision" | "updatedAt">,
): Promise<ProviderSettings> {
  const result = await transaction<ProviderSettings>(SETTINGS_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(SETTINGS_STORE);
    const request = store.get(CURRENT);
    request.onsuccess = () => {
      const record = request.result as unknown;
      const current =
        record === undefined
          ? { schemaVersion: 1 as const, revision: 0, updatedAt: new Date(0).toISOString() }
          : fromStoredSettings(settingsSchema.parse(record));
      const next: ProviderSettings = {
        ...updater(current),
        schemaVersion: 1,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      const write = store.put(settingsRecord(next));
      write.onsuccess = () => setResult(tx, next);
    };
  });
  notifySettings(result.revision);
  return result;
}

export function saveProvider(
  capability: DailyCapability,
  provider: ProviderSettings[DailyCapability],
) {
  if (!provider) throw new DailyStorageError("配置不完整，无法保存。");
  const normalized = normalizeProviderForStorage(provider);
  const validated = validateProviderForStorage(capability, normalized);
  return writeProviderSettings(
    (current) =>
      ({
        ...(current.chat ? { chat: current.chat } : {}),
        ...(current.asr ? { asr: current.asr } : {}),
        ...(current.local ? { local: current.local } : {}),
        ...(current.tts ? { tts: current.tts } : {}),
        [capability]: validated,
      }) as Omit<ProviderSettings, "schemaVersion" | "revision" | "updatedAt">,
  );
}

export function saveAsrDirectPreference(enabled: boolean) {
  return writeProviderSettings((current) => ({
    ...(current.chat ? { chat: current.chat } : {}),
    ...(current.asr ? { asr: current.asr } : {}),
    ...(enabled ? { local: { asrDirect: true } } : {}),
    ...(current.tts ? { tts: current.tts } : {}),
  }));
}

export function clearProvider(capability: DailyCapability) {
  return writeProviderSettings((current) => {
    const next: { chat?: ChatProvider; asr?: AsrProvider; tts?: TtsProvider } = {
      ...(current.chat ? { chat: current.chat } : {}),
      ...(current.asr ? { asr: current.asr } : {}),
      ...(current.tts ? { tts: current.tts } : {}),
    };
    delete next[capability];
    return {
      ...next,
      ...(current.local ? { local: current.local } : {}),
    } as Omit<ProviderSettings, "schemaVersion" | "revision" | "updatedAt">;
  });
}

export function clearAllProviders() {
  return writeProviderSettings(() => ({}));
}
