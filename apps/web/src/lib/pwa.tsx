import { useRegisterSW } from "virtual:pwa-register/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

type PwaContextValue = {
  busy: boolean;
  setBusy: (busy: boolean, key?: string) => void;
};

import { createContext, useContext } from "react";
const PwaContext = createContext<PwaContextValue | null>(null);
const IOS_INSTALL_DISMISSED_KEY = "kotoba.pwa.ios-install-dismissed.v1";

export function PwaProvider({ children }: { children: ReactNode }) {
  const busyRef = useRef(false);
  const busyKeysRef = useRef(new Set<string>());
  const [busy, setBusyState] = useState(false);
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({ immediate: true });
  const [installed, setInstalled] = useState(false);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [iosGuide, setIosGuide] = useState(false);
  const [iosDevice, setIosDevice] = useState(false);
  const [iosInstallDismissed, setIosInstallDismissed] = useState(false);

  const setBusy = useCallback((value: boolean, key = "global") => {
    if (value) busyKeysRef.current.add(key);
    else busyKeysRef.current.delete(key);
    const next = busyKeysRef.current.size > 0;
    busyRef.current = next;
    setBusyState(next);
  }, []);

  useEffect(() => {
    const checkStandalone = () => {
      setInstalled(
        window.matchMedia("(display-mode: standalone)").matches ||
          (navigator as Navigator & { standalone?: boolean }).standalone === true,
      );
    };
    checkStandalone();
    const iosLike =
      /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    setIosDevice(iosLike);
    try {
      setIosInstallDismissed(localStorage.getItem(IOS_INSTALL_DISMISSED_KEY) === "1");
    } catch {
      // Private browsing may deny localStorage; showing the guide is safer.
    }
    const beforeInstall = (event: Event) => {
      if (!import.meta.env.PROD) return;
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
    };
    const installedHandler = () => {
      setInstalled(true);
      setInstallEvent(null);
    };
    window.addEventListener("beforeinstallprompt", beforeInstall);
    window.addEventListener("appinstalled", installedHandler);
    window.addEventListener("pageshow", checkStandalone);
    return () => {
      window.removeEventListener("beforeinstallprompt", beforeInstall);
      window.removeEventListener("appinstalled", installedHandler);
      window.removeEventListener("pageshow", checkStandalone);
    };
  }, []);

  const ios = import.meta.env.PROD && iosDevice && !installed && !iosInstallDismissed;
  const dismissInstall = () => {
    setInstallEvent(null);
    if (iosDevice) {
      setIosInstallDismissed(true);
      try {
        localStorage.setItem(IOS_INSTALL_DISMISSED_KEY, "1");
      } catch {
        // Dismissal is best effort in private browsing.
      }
    }
  };
  const install = async () => {
    if (!installEvent) {
      dismissInstall();
      setIosGuide(true);
      return;
    }
    await installEvent.prompt();
    setInstallEvent(null);
  };

  return (
    <PwaContext.Provider value={{ busy, setBusy }}>
      {children}
      {offlineReady ? (
        <PwaNotice onDismiss={() => setOfflineReady(false)}>离线页面已准备好。</PwaNotice>
      ) : null}
      {needRefresh ? (
        <PwaNotice
          actionLabel={busy ? "处理中" : "更新"}
          actionDisabled={busy}
          onAction={() => {
            if (!busyRef.current) {
              setNeedRefresh(false);
              void updateServiceWorker(true);
            }
          }}
          onDismiss={() => setNeedRefresh(false)}
        >
          有新版本可用。请先完成当前操作。
        </PwaNotice>
      ) : null}
      {!installed && (installEvent || ios) ? (
        <PwaNotice actionLabel="安装" onAction={() => void install()} onDismiss={dismissInstall}>
          添加每日故事对话到主屏幕。
        </PwaNotice>
      ) : null}
      {iosGuide ? (
        <PwaNotice onDismiss={() => setIosGuide(false)}>
          在 iPhone 或 iPad 上，点“分享”，再点“添加到主屏幕”。
        </PwaNotice>
      ) : null}
    </PwaContext.Provider>
  );
}

function PwaNotice({
  children,
  actionLabel,
  actionDisabled,
  onAction,
  onDismiss,
}: {
  children: ReactNode;
  actionLabel?: string;
  actionDisabled?: boolean;
  onAction?: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className="fixed inset-x-3 z-50 mx-auto flex max-w-xl items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 text-sm shadow-lift"
      style={{ bottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
      <p className="flex-1 text-muted-foreground">{children}</p>
      {actionLabel && onAction ? (
        <Button size="sm" disabled={actionDisabled} onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" onClick={onDismiss} aria-label="Dismiss">
        ×
      </Button>
    </div>
  );
}

export function usePwa() {
  const context = useContext(PwaContext);
  if (!context) throw new Error("usePwa must be used inside PwaProvider");
  return context;
}

declare global {
  interface BeforeInstallPromptEvent extends Event {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
  }
}
