/**
 * SafeNode — policy firewall for AI agent actions.
 *
 * Evaluate what an agent is about to do, before it does it.
 *
 * ```ts
 * import { SafeNode } from "safenode-sdk";
 *
 * const sn = new SafeNode(process.env.SAFENODE_API_KEY!);
 * const result = await sn.evaluate("send_email", { to: "user@example.com" });
 * if (result.denied) throw new Error(result.reasons.join("; "));
 * ```
 *
 * Two things worth knowing before you ship:
 *
 * - `onUnavailable` defaults to `"fail_open"` — if SafeNode is unreachable, actions are allowed
 *   and the result carries `degraded: true`. Change it to `"fail_closed"` for anything where an
 *   unevaluated action is worse than a failed one.
 * - `payloadMode` defaults to `"redacted"` — payloads are scrubbed client-side before they are
 *   sent. Use `"metadata_only"` to send no values at all.
 *
 * No telemetry. This package makes exactly one network call, to the SafeNode API, when you ask it
 * to.
 */

export {
  DEFAULT_BASE_URL,
  ON_UNAVAILABLE_MODES,
  SafeNode,
  type EvaluateOptions,
  type FetchLike,
  type GuardCallback,
  type GuardOptions,
  type GuardedOptions,
  type Logger,
  type OnUnavailable,
  type SafeNodeOptions,
} from "./client.js";

export {
  APIError,
  AuthError,
  ConfigurationError,
  PayloadTooLargeError,
  PolicyDenied,
  QuotaExceededError,
  RateLimitError,
  SafeNodeError,
  Unavailable,
  ValidationError,
} from "./errors.js";

export {
  DECISIONS,
  DEGRADED_REASON,
  Result,
  type Alternative,
  type Decision,
  type MatchedPolicy,
} from "./models.js";

export {
  DEFAULT_RULES,
  Redactor,
  redactionRule,
  type RedactionReport,
  type RedactionRule,
  type RedactorOptions,
} from "./redaction.js";

export {
  buildEnvelope,
  PAYLOAD_MODES,
  type EvaluateRequestBody,
  type PayloadMode,
} from "./envelope.js";

export { VERSION } from "./version.js";
