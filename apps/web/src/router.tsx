import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

const getSsrNonce = import.meta.env.SSR
  ? (await import("./lib/csp-nonce.server")).currentCspNonce
  : () => undefined;

export const getRouter = () => {
  const queryClient = new QueryClient();
  const nonce = getSsrNonce();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    ...(nonce ? { ssr: { nonce } } : {}),
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  return router;
};
