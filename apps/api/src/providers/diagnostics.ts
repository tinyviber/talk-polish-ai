import type { ProviderCapability, ProviderDiagnostics } from "@kotoba/contracts";
import { pingDatabase } from "../db/client";
import { env } from "../env";
import { safeProviderError } from "./http";
import { providers } from "./index";
import type { Providers } from "./index";
import type { Env } from "../env";

export async function diagnoseProviders(
  requestId: string,
  activeProbe = false,
  config = env(),
  current = providers(config),
): Promise<ProviderDiagnostics> {
  const checkedAt = new Date().toISOString();
  const databaseUp = await pingDatabase();
  const database: ProviderCapability = {
    status: databaseUp ? "available" : "failed",
    provider: "postgresql",
    checkedAt,
    ...(databaseUp ? {} : { errorCode: "connection" }),
  };

  return {
    requestId,
    database,
    storage: await capability(
      "storage",
      current.storage.name,
      current.storage.check,
      true,
      activeProbe,
      checkedAt,
      current.storage.probe,
    ),
    chat: await capability(
      "chat",
      current.assessment.name,
      current.assessment.check,
      config.ASSESSMENT_PROVIDER !== "mock",
      activeProbe,
      checkedAt,
      current.assessment.probe,
    ),
    transcription: await capability(
      "transcription",
      current.transcription.name,
      current.transcription.check,
      config.TRANSCRIPTION_PROVIDER !== "mock",
      activeProbe,
      checkedAt,
      current.transcription.probe,
    ),
    tts: await capability(
      "tts",
      current.tts.name,
      current.tts.check,
      config.TTS_PROVIDER !== "mock",
      activeProbe,
      checkedAt,
      current.tts.probe,
    ),
    realtime: await realtimeCapability(current.realtime, activeProbe, checkedAt, config),
  };
}

async function capability(
  _capability: string,
  provider: string,
  check: (() => Promise<void>) | undefined,
  configured: boolean,
  activeProbe: boolean,
  checkedAt: string,
  probe?: () => Promise<void>,
): Promise<ProviderCapability> {
  if (!configured) return { status: "available", provider, checkedAt };
  try {
    await check?.();
    if (activeProbe && probe) await probe();
    return { status: activeProbe && probe ? "available" : "configured", provider, checkedAt };
  } catch (error) {
    return { status: "failed", provider, checkedAt, errorCode: safeProviderError(error) };
  }
}

async function realtimeCapability(
  realtime: Providers["realtime"],
  activeProbe: boolean,
  checkedAt: string,
  config: Env,
): Promise<ProviderCapability> {
  if (!realtime.configured) {
    return {
      status: config.REALTIME_FEATURE_ENABLED ? "failed" : "unsupported",
      provider: realtime.name,
      checkedAt,
      ...(config.REALTIME_FEATURE_ENABLED ? { errorCode: "configuration" } : {}),
    };
  }
  try {
    realtime.checkConfiguration();
    if (activeProbe) await realtime.smokeTest();
    return { status: activeProbe ? "available" : "configured", provider: realtime.name, checkedAt };
  } catch (error) {
    return {
      status: "failed",
      provider: realtime.name,
      checkedAt,
      errorCode: safeProviderError(error),
    };
  }
}
