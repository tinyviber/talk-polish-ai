import type { Env } from "./env";
import { createAttemptApplication } from "./modules/attempts/service";
import { providers, type Providers } from "./providers";

export type Runtime = {
  config: Env;
  providers: Providers;
  attemptApplication: ReturnType<typeof createAttemptApplication>;
};

/** API composition root: concrete capabilities are created once and injected. */
export function buildRuntime(config: Env): Runtime {
  const providerSet = providers(config);
  return {
    config,
    providers: providerSet,
    attemptApplication: createAttemptApplication(providerSet),
  };
}
