/** Service-worker request boundaries kept pure so they can be tested without a browser worker. */
export function isPublicPromptsRequest(url: URL, request: Request, origin = url.origin) {
  return (
    request.method === "GET" &&
    !request.headers.has("authorization") &&
    !request.headers.has("cookie") &&
    url.origin === origin &&
    url.pathname === "/api/prompts"
  );
}

export function isNetworkOnlyPath(url: URL) {
  return url.pathname.startsWith("/api/") || url.pathname.startsWith("/realtime/");
}

export function isPublicNavigationRequest(request: Request, url: URL) {
  return (
    request.mode === "navigate" &&
    !request.headers.has("authorization") &&
    !request.headers.has("cookie") &&
    !isNetworkOnlyPath(url)
  );
}
