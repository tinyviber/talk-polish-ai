import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { PracticeStoreProvider } from "../lib/practice/store";
import { Toaster } from "../components/ui/sonner";
import { PwaProvider, usePwa } from "../lib/pwa";
import { getLearnerId } from "../lib/practice/api";
import { syncRecordingQueue } from "../lib/practice/offlineQueue";
import { uploadQueuedAttempt } from "../lib/practice/api";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: "Kotoba Loop — speaking practice" },
      {
        name: "description",
        content: "Practice speaking English and Japanese out loud with instant, focused coaching.",
      },
      { property: "og:title", content: "Kotoba Loop — speaking practice" },
      {
        property: "og:description",
        content: "Practice speaking English and Japanese out loud with instant, focused coaching.",
      },
      { property: "og:type", content: "website" },
      { name: "theme-color", content: "#f7f1e5" },
      { name: "application-name", content: "Kotoba Loop" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "default" },
      { name: "apple-mobile-web-app-title", content: "Kotoba Loop" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:site", content: "@Lovable" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
      { rel: "manifest", href: "/manifest.webmanifest" },
      {
        rel: "apple-touch-icon",
        href: "/apple-touch-icon-180.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <PwaProvider>
      <OfflineQueueSync />
      <QueryClientProvider client={queryClient}>
        <PracticeStoreProvider>
          {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
          <Outlet />
          <Toaster position="top-center" />
        </PracticeStoreProvider>
      </QueryClientProvider>
    </PwaProvider>
  );
}

function OfflineQueueSync() {
  const { setBusy } = usePwa();
  useEffect(() => {
    const sync = () => {
      const learnerId = getLearnerId();
      if (!learnerId) return;
      setBusy(true, "queue");
      void syncRecordingQueue(async (item) => {
        const { attempt, sessionId } = await uploadQueuedAttempt(item);
        return { id: attempt.id, status: attempt.status, sessionId };
      }, learnerId).finally(() => setBusy(false, "queue"));
    };
    sync();
    window.addEventListener("online", sync);
    const onVisibility = () => {
      if (document.visibilityState === "visible") sync();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("kotoba:retry-queue", sync);
    window.addEventListener("kotoba:learner-ready", sync);
    return () => {
      window.removeEventListener("online", sync);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("kotoba:retry-queue", sync);
      window.removeEventListener("kotoba:learner-ready", sync);
    };
  }, [setBusy]);
  return null;
}
