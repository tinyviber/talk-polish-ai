import { getStartContext } from "@tanstack/start-storage-context";

const nonces = new WeakMap<Request, string>();

function randomNonce() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let binary = "";
  bytes.forEach((value) => {
    binary += String.fromCharCode(value);
  });
  return btoa(binary);
}

export function attachCspNonce(request: Request) {
  const nonce = randomNonce();
  nonces.set(request, nonce);
  return nonce;
}

export function releaseCspNonce(request: Request) {
  nonces.delete(request);
}

/** Called while TanStack Start has this request in AsyncLocalStorage. */
export function currentCspNonce() {
  const request = getStartContext({ throwIfNotFound: false })?.request;
  return request ? nonces.get(request) : undefined;
}

export function cspHeader(nonce: string) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
