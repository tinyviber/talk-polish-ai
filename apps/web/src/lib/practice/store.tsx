import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { PROMPTS } from "@kotoba/contracts";
import {
  bootstrapLearner,
  deleteSaved,
  getProgress,
  listPrompts,
  listSaved,
  saveExpression,
} from "./api";
import { configuredAppMode, type AppMode } from "./mode";
import type { Expression, Lang, Prompt, ProgressState, SessionRecord } from "./types";

const KEY = "kotoba.state.v1";
const EMPTY: ProgressState = { sessions: [], saved: [], lang: null, onboarded: false };

function loadDemo(): ProgressState {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    return { ...EMPTY, ...(JSON.parse(raw) as Partial<ProgressState>) };
  } catch {
    return EMPTY;
  }
}

type Ctx = {
  ready: boolean;
  mode: AppMode;
  configuredMode: AppMode;
  error: string | null;
  state: ProgressState;
  prompts: Prompt[];
  setLang: (lang: Lang) => void;
  completeOnboarding: (lang: Lang) => Promise<void>;
  toggleSaved: (e: Expression) => Promise<void>;
  isSaved: (id: string) => boolean;
  recordSession: (s: SessionRecord) => void;
  refresh: () => Promise<void>;
  switchToDemo: () => void;
  reset: () => void;
};

const StoreContext = createContext<Ctx | null>(null);

function errorMessage(error: unknown) {
  return error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : "Something went wrong. Please try again.";
}

export function PracticeStoreProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<AppMode>(configuredAppMode);
  const [state, setState] = useState<ProgressState>(EMPTY);
  const [prompts, setPrompts] = useState<Prompt[]>(configuredAppMode === "demo" ? PROMPTS : []);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "demo") return;
    setState(loadDemo());
    setPrompts(PROMPTS);
    setReady(true);
  }, [mode]);

  useEffect(() => {
    if (!ready || mode !== "demo") return;
    try {
      window.localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // Demo still works in memory when browser storage is unavailable.
    }
  }, [mode, ready, state]);

  const refreshApi = useCallback(
    async (lang: Lang | null, background = false, ensureBootstrap = false) => {
      if (!lang) return;
      if (!background) setReady(false);
      setError(null);
      try {
        if (ensureBootstrap) await bootstrapLearner(lang);
        const [nextPrompts, progress, saved] = await Promise.all([
          listPrompts(),
          getProgress(),
          listSaved(),
        ]);
        setPrompts(nextPrompts);
        setState((current) => ({
          ...current,
          lang,
          onboarded: true,
          sessions: progress.sessions,
          saved,
        }));
      } catch (cause) {
        setError(errorMessage(cause));
        throw cause;
      } finally {
        if (!background) setReady(true);
      }
    },
    [],
  );

  useEffect(() => {
    if (mode !== "api") return;
    let cancelled = false;
    setReady(false);
    setError(null);

    void (async () => {
      try {
        const learner = await bootstrapLearner(null);
        if (cancelled) return;
        if (!learner.lang) {
          setState(EMPTY);
          return;
        }
        await refreshApi(learner.lang);
      } catch (cause) {
        if (!cancelled) setError(errorMessage(cause));
      } finally {
        if (!cancelled) setReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mode, refreshApi]);

  const setLang = useCallback(
    (lang: Lang) => {
      if (mode === "demo") {
        setState((current) => ({ ...current, lang }));
        return;
      }
      setState((current) => ({ ...current, lang, onboarded: true }));
      void refreshApi(lang, false, true).catch(() => undefined);
    },
    [mode, refreshApi],
  );

  const completeOnboarding = useCallback(
    async (lang: Lang) => {
      setError(null);
      if (mode === "demo") {
        setState((current) => ({ ...current, lang, onboarded: true }));
        return;
      }
      try {
        await refreshApi(lang, false, true);
      } catch (cause) {
        setError(errorMessage(cause));
        throw cause;
      } finally {
        setReady(true);
      }
    },
    [mode, refreshApi],
  );

  const toggleSaved = useCallback(
    async (expression: Expression) => {
      if (mode === "demo") {
        setState((current) => {
          const exists = current.saved.some((item) => item.id === expression.id);
          return {
            ...current,
            saved: exists
              ? current.saved.filter((item) => item.id !== expression.id)
              : [{ ...expression, savedAt: Date.now() }, ...current.saved],
          };
        });
        return;
      }

      setError(null);
      try {
        if (state.saved.some((item) => item.id === expression.id)) {
          await deleteSaved(expression.id);
          setState((current) => ({
            ...current,
            saved: current.saved.filter((item) => item.id !== expression.id),
          }));
        } else {
          const saved = await saveExpression(expression);
          setState((current) => ({
            ...current,
            saved: [saved, ...current.saved.filter((item) => item.id !== saved.id)],
          }));
        }
      } catch (cause) {
        setError(errorMessage(cause));
        throw cause;
      }
    },
    [mode, state.saved],
  );

  const recordSession = useCallback(
    (record: SessionRecord) => {
      if (mode === "api") return;
      setState((current) => ({
        ...current,
        sessions: [record, ...current.sessions.filter((item) => item.id !== record.id)].slice(
          0,
          60,
        ),
      }));
    },
    [mode],
  );

  const refresh = useCallback(async () => {
    if (mode === "api") await refreshApi(state.lang, true);
  }, [mode, refreshApi, state.lang]);

  const switchToDemo = useCallback(() => {
    setError(null);
    setMode("demo");
    setState({ ...loadDemo(), onboarded: true });
    setPrompts(PROMPTS);
  }, []);

  const reset = useCallback(() => {
    setState(EMPTY);
    if (mode === "demo") {
      try {
        window.localStorage.removeItem(KEY);
      } catch {
        // Ignore unavailable demo storage.
      }
    }
  }, [mode]);

  const value = useMemo<Ctx>(
    () => ({
      ready,
      mode,
      configuredMode: configuredAppMode,
      error,
      state,
      prompts,
      setLang,
      completeOnboarding,
      toggleSaved,
      isSaved: (id: string) => state.saved.some((item) => item.id === id),
      recordSession,
      refresh,
      switchToDemo,
      reset,
    }),
    [
      ready,
      mode,
      error,
      state,
      prompts,
      setLang,
      completeOnboarding,
      toggleSaved,
      recordSession,
      refresh,
      switchToDemo,
      reset,
    ],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function usePracticeStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("usePracticeStore must be used inside PracticeStoreProvider");
  return ctx;
}

/** Streak = consecutive days (ending today or yesterday) with at least one session. */
export function computeStreak(sessions: SessionRecord[]) {
  const days = new Set(sessions.map((session) => session.date));
  if (days.size === 0) return 0;
  const date = new Date();
  const iso = (value: Date) => value.toISOString().slice(0, 10);
  if (!days.has(iso(date))) {
    date.setDate(date.getDate() - 1);
    if (!days.has(iso(date))) return 0;
  }
  let streak = 0;
  while (days.has(iso(date))) {
    streak += 1;
    date.setDate(date.getDate() - 1);
  }
  return streak;
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
