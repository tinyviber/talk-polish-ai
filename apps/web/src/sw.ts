/// <reference lib="webworker" />

import { clientsClaim } from "workbox-core";
import type { WorkboxPlugin } from "workbox-core/types.js";
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { CacheableResponsePlugin } from "workbox-cacheable-response";
import { ExpirationPlugin } from "workbox-expiration";
import { NetworkFirst, NetworkOnly } from "workbox-strategies";
import { isNetworkOnlyPath, isPublicNavigationRequest, isPublicPromptsRequest } from "./sw-rules";

// Workbox 7's package declarations disagree under exactOptionalPropertyTypes
// even though these built-in plugins implement the same runtime interface.
const workboxPlugins = (...plugins: unknown[]) => plugins as WorkboxPlugin[];

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision?: string | null }>;
};

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
clientsClaim();

const navigation = new NetworkFirst({
  cacheName: "kotoba-navigation-v2",
  networkTimeoutSeconds: 4,
  plugins: workboxPlugins(
    new CacheableResponsePlugin({ statuses: [200] }),
    new ExpirationPlugin({ maxEntries: 20, maxAgeSeconds: 24 * 60 * 60 }),
  ),
});

registerRoute(
  ({ request, url }) => isPublicNavigationRequest(request, url, self.location.origin),
  async ({ event, request }) => {
    try {
      const response = await navigation.handle({ event, request });
      if (response) return response;
    } catch {
      // Offline fallback below is deliberately a precached static page.
    }
    return (await matchPrecache("/offline.html")) ?? Response.error();
  },
);

registerRoute(
  ({ url, request }) => isPublicPromptsRequest(url, request, self.location.origin),
  new NetworkFirst({
    cacheName: "kotoba-public-prompts-v2",
    networkTimeoutSeconds: 3,
    plugins: workboxPlugins(
      new CacheableResponsePlugin({ statuses: [200] }),
      new ExpirationPlugin({ maxEntries: 8, maxAgeSeconds: 6 * 60 * 60 }),
    ),
  }),
);

// Authenticated reads, all mutations, audio, diagnostics, provider and realtime
// endpoints are never replayed or stored by this worker.
registerRoute(({ url }) => isNetworkOnlyPath(url), new NetworkOnly());
registerRoute(({ url }) => isNetworkOnlyPath(url), new NetworkOnly(), "POST");

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});
