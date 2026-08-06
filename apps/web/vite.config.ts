// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  vite: {
    plugins: [
      VitePWA({
        // Nitro publishes the client build (hashed assets, icons, fonts,
        // offline.html) under .output/public. Workbox must read that directory
        // or the precache manifest ships without the real app shell.
        // Nitro publishes the production web client under .output/public.
        // Keep Workbox output in same directory so final Node server artifact
        // includes sw.js and precache sees hashed client assets.
        outDir: ".output/public",
        registerType: "prompt",
        strategies: "injectManifest",
        srcDir: "src",
        filename: "sw.ts",
        includeAssets: [
          "offline.html",
          "favicon.ico",
          "apple-touch-icon.png",
          "apple-touch-icon-180.png",
          "icons/*.png",
          "fonts/*.ttf",
        ],
        manifest: {
          id: "/",
          name: "Kotoba Loop",
          short_name: "Kotoba Loop",
          description: "Focused speaking practice for English and Japanese.",
          start_url: "/?source=pwa",
          scope: "/",
          display: "standalone",
          orientation: "portrait-primary",
          theme_color: "#f7f1e5",
          background_color: "#f7f1e5",
          lang: "en",
          categories: ["education", "productivity"],
          icons: [
            { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
            { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
            {
              src: "/icons/icon-maskable-512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
        injectManifest: {
          globPatterns: ["**/*.{js,css,html,svg,ico,png,ttf,woff,woff2}"],
          maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        },
        devOptions: { enabled: false },
      }),
    ],
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  // Production runs the generated .output/server/index.mjs behind Caddy/Nginx.
  // This avoids requiring a Wrangler/Cloudflare runtime for the same-origin PWA.
  nitro: { preset: "node-server" },
});
