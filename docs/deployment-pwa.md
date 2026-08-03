# PWA deployment notes

Serve the web app and Fastify API on the same HTTPS origin whenever possible. Build production with `VITE_APP_MODE=api` and an empty `VITE_API_URL`; the web client then uses relative `/api` requests. Set `VITE_API_URL` only when the API is intentionally on another origin and configure CORS explicitly.

The Vite wrapper is explicitly configured for Nitro's `node-server` preset. Build and run the web server with `bun run build:web` followed by `bun --filter @kotoba/web start`; it listens on `3000` and serves `.output/public` plus SSR. Fastify remains on `3333`. The Nginx example's `map` belongs in the `http {}` block (Caddy needs no equivalent).

Publish the web output as a release, not by replacing a live `.output` directory. For example: build in a staging checkout, move the completed `.output` to `/srv/kotoba/releases/<build-id>/.output`, atomically switch `/srv/kotoba/current` to that release, then restart the Node service with `/srv/kotoba/current/.output/server/index.mjs`. Keep the previous release until the new worker activates and health checks pass.

`deploy/Caddyfile` and `deploy/nginx.conf` include HTTPS, security headers, and the required cache policy. `sw.js`, `manifest.webmanifest`, and `offline.html` must be revalidated (`no-cache`) so a new service worker can detect updates. Vite-hashed JS/CSS and static icons/fonts can be immutable. Never proxy or cache authenticated audio, recordings, feedback, diagnostics, provider, realtime, or POST routes in an edge cache. API responses default to `private, no-store`; only public prompts may be short-lived.

The service worker uses `injectManifest` and `registerType: prompt`. It precaches the hashed shell plus the offline page, icons, and local fonts. Navigation is NetworkFirst with `/offline.html` fallback; public `GET /api/prompts` has a short bounded cache. All other `/api` routes are NetworkOnly. Deploy the new build atomically, keep the previous build available until the new worker activates, and bump the cache names in `apps/web/src/sw.ts` when changing cache semantics.

Do not auto-reload while recording, uploading, or processing. The UI asks for update confirmation and disables confirmation while busy. If an update is stuck, close active recording/processing, accept the prompt, and verify the new `sw.js` response is not served from a stale proxy cache.

The IndexedDB outbox is scoped by `learnerId` and uses a client-generated `clientAttemptId`; startup after learner bootstrap, restored visibility, network recovery, and manual retry perform foreground sync. Background Sync is not required. Lifecycle recovery is best-effort: an iOS force-kill or OS suspension can discard in-memory chunks even though visibility, pagehide, track, MediaRecorder, and AudioContext interruptions attempt to finalize a Blob.
