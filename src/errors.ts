/**
 * Exception hierarchy.
 *
 * Every error thrown by this SDK inherits from {@link SafeNodeError}, so
 * `catch (e) { if (e instanceof SafeNodeError) ... }` is always sufficient to contain the SDK.
 *
 * The one distinction worth learning: {@link RateLimitError} and {@link QuotaExceededError} both
 * come from an HTTP 429, but only the first is retryable. See their docs.
 */

import type { Result } from "./models.js";

/** Base class for every error this SDK throws. */
export class SafeNodeError extends Error {
  override readonly message: string;
  readonly traceId: string | null;

  constructor(message: string, options: { traceId?: string | null | undefined } = {}) {
    super(message);
    this.name = "SafeNodeError";
    this.message = message;
    this.traceId = options.traceId ?? null;
  }
}

/**
 * The client was constructed with invalid or missing options.
 *
 * Thrown eagerly at construction time rather than on first request, so misconfiguration surfaces
 * at startup instead of in the middle of a hot path.
 */
export class ConfigurationError extends SafeNodeError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export interface APIErrorOptions {
  statusCode: number;
  body?: Record<string, unknown> | null | undefined;
  traceId?: string | null | undefined;
}

/** Base for errors carrying an HTTP response from SafeNode. */
export class APIError extends SafeNodeError {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;

  constructor(message: string, options: APIErrorOptions) {
    super(message, { traceId: options.traceId });
    this.name = "APIError";
    this.statusCode = options.statusCode;
    this.body = options.body ?? {};
  }
}

/**
 * HTTP 401. The API key is missing, malformed, invalid, expired, or unbound.
 *
 * Never retryable. Check `SAFENODE_API_KEY`.
 */
export class AuthError extends APIError {
  constructor(message: string, options: APIErrorOptions) {
    super(message, options);
    this.name = "AuthError";
  }
}

/**
 * HTTP 422. The request was rejected by server-side validation.
 *
 * `errors` is the field-level detail, and may be empty: the oversize-payload variant of 422
 * returns no `errors` key. See {@link PayloadTooLargeError}.
 */
export class ValidationError extends APIError {
  readonly errors: Record<string, string[]>;

  constructor(message: string, options: APIErrorOptions) {
    super(message, options);
    this.name = "ValidationError";
    const raw = this.body["errors"];
    this.errors = isPlainObject(raw) ? (raw as Record<string, string[]>) : {};
  }
}

/**
 * HTTP 422 caused by size, not by validation.
 *
 * `payload` and `context` are each limited to 256 KiB of JSON *independently* — this is not a
 * combined budget. Reduce what you send, or switch to `payloadMode: "metadata_only"`.
 */
export class PayloadTooLargeError extends ValidationError {
  constructor(message: string, options: APIErrorOptions) {
    super(message, options);
    this.name = "PayloadTooLargeError";
  }
}

/**
 * HTTP 429 from throttling. **Retryable** after `retryAfter` seconds.
 *
 * Distinct from {@link QuotaExceededError}, which shares the same status code but is not
 * retryable. The SDK discriminates on the response body, so you do not have to.
 */
export class RateLimitError extends APIError {
  /** Seconds, taken from the `Retry-After` response header. */
  readonly retryAfter: number | null;

  constructor(message: string, options: APIErrorOptions & { retryAfter?: number | null | undefined }) {
    super(message, options);
    this.name = "RateLimitError";
    this.retryAfter = options.retryAfter ?? null;
  }
}

/**
 * HTTP 429 because the organization's monthly evaluation allowance is exhausted.
 *
 * **Not retryable.** The allowance resets at the start of the next billing month; retrying with
 * backoff will fail for the remainder of it. Upgrade the plan or raise the cap.
 *
 * Identified by the presence of `evaluations_cap` in the response body.
 */
export class QuotaExceededError extends APIError {
  readonly evaluationsUsed: number | null;
  readonly evaluationsCap: number | null;

  constructor(message: string, options: APIErrorOptions) {
    super(message, options);
    this.name = "QuotaExceededError";
    const used = this.body["evaluations_used"];
    const cap = this.body["evaluations_cap"];
    this.evaluationsUsed = typeof used === "number" ? used : null;
    this.evaluationsCap = typeof cap === "number" ? cap : null;
  }
}

/**
 * SafeNode could not be reached, or returned 5xx.
 *
 * Only thrown when `onUnavailable: "raise"`. Under `"fail_open"` / `"fail_closed"` the SDK
 * returns a synthetic {@link Result} with `degraded: true` instead.
 *
 * `cause` is the underlying transport error, when there was one. Its presence is also what makes
 * a failure non-retryable: a 5xx has no cause and may be retried, a timeout has one and never is.
 */
export class Unavailable extends SafeNodeError {
  override readonly cause?: unknown;

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = "Unavailable";
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * The action was not permitted by policy.
 *
 * Thrown by `guard()` and `guarded()`, never by `evaluate()` — a `deny` is a successful
 * evaluation, and `evaluate()` returns it as a {@link Result} for you to branch on.
 *
 * Carries the full `result` so callers can inspect `reasons`, `alternatives` and `traceId`.
 */
export class PolicyDenied extends SafeNodeError {
  readonly result: Result;
  readonly decision: string;
  readonly reasons: string[];

  constructor(result: Result) {
    const reasons = result.reasons.length > 0 ? result.reasons.join("; ") : result.decision;
    super(`Action denied by SafeNode policy: ${reasons}`, { traceId: result.traceId });
    this.name = "PolicyDenied";
    this.result = result;
    this.decision = result.decision;
    this.reasons = [...result.reasons];
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
