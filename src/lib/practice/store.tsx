import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Expression, Lang, ProgressState, SessionRecord } from "./types";

const KEY = "kotoba.state.v1";

const EMPTY: ProgressState = { sessions: [], saved: [], lang: null, onboarded: false };

function load(): ProgressState {
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
  state: ProgressState;
  setLang: (lang: Lang) => void;
  completeOnboarding: (lang: Lang) => void;
  toggleSaved: (e: Expression) => void;
  isSaved: (id: string) => boolean;
  recordSession: (s: SessionRecord) => void;
  reset: () => void;
};

const StoreContext = createContext<Ctx | null>(null);

export function PracticeStoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ProgressState>(EMPTY);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setState(load());
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    try {
      window.localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* storage unavailable — session still works in memory */
    }
  }, [state, ready]);

  const setLang = useCallback((lang: Lang) => setState((s) => ({ ...s, lang })), []);

  const completeOnboarding = useCallback(
    (lang: Lang) => setState((s) => ({ ...s, lang, onboarded: true })),
    [],
  );

  const toggleSaved = useCallback((e: Expression) => {
    setState((s) => {
      const exists = s.saved.some((x) => x.id === e.id);
      return {
        ...s,
        saved: exists
          ? s.saved.filter((x) => x.id !== e.id)
          : [{ ...e, savedAt: Date.now() }, ...s.saved],
      };
    });
  }, []);

  const recordSession = useCallback((rec: SessionRecord) => {
    setState((s) => {
      const rest = s.sessions.filter((x) => x.id !== rec.id);
      return { ...s, sessions: [rec, ...rest].slice(0, 60) };
    });
  }, []);

  const reset = useCallback(() => setState(EMPTY), []);

  const value = useMemo<Ctx>(
    () => ({
      ready,
      state,
      setLang,
      completeOnboarding,
      toggleSaved,
      isSaved: (id: string) => state.saved.some((x) => x.id === id),
      recordSession,
      reset,
    }),
    [ready, state, setLang, completeOnboarding, toggleSaved, recordSession, reset],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function usePracticeStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("usePracticeStore must be used inside PracticeStoreProvider");
  return ctx;
}

/** Streak = consecutive days (ending today or yesterday) with at least one session. */
export function computeStreak(sessions: SessionRecord[]): number {
  const days = new Set(sessions.map((s) => s.date));
  if (days.size === 0) return 0;
  const d = new Date();
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  if (!days.has(iso(d))) {
    d.setDate(d.getDate() - 1);
    if (!days.has(iso(d))) return 0;
  }
  let n = 0;
  while (days.has(iso(d))) {
    n += 1;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
