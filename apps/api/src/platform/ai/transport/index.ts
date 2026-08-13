/**
 * Public platform transport facade.
 *
 * The implementations remain in providers/ so this seam cannot accidentally
 * fork or weaken the existing SSRF, DNS, redirect, retry, or diagnostics rules.
 */
export {
  DailyProviderRequestError,
  createDailySafeHttpsClient,
  type DailySafeHttpsClientOptions,
} from "../../../providers/safe-https-client";
export {
  DailyProviderConfigurationError,
  DailyProviderDnsError,
  assertDailyProviderUrlAllowed,
  isPublicInternetAddress,
  joinDailyProviderPath,
  parseDailyProviderBaseUrl,
  resolveDailyProviderPublicAddresses,
  type DailyProviderTarget,
  type DailyProviderUrlPolicy,
} from "../../../providers/outbound-url-policy";
export { diagnoseProviders } from "../../../providers/diagnostics";
