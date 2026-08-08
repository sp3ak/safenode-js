/**
 * The SafeNode client.
 *
 * One class, `SafeNode`. JavaScript has no blocking I/O, so where the Python SDK ships a sync
 * `SafeNode` and an async `AsyncSafeNode`, this SDK ships a single async client with the same
 * option names, the same result fields, and the same behaviour.
 */

import {
  buildEnvelope,
  PAYLOAD_MODES,
  type EvaluateRequestBody,
  type PayloadMode,
} from "./envelope.js";
import {
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
import { Result } from "./models.js";
import { Redactor } from "./redaction.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://safenode.tech";
const EVALUATE_PATH = "/api/v1/evaluate";

export const ON_UNAVAILABLE_MODES = ["fail_open", "fail_closed", "raise"] as const;
export type OnUnavailable = (typeof ON_UNAVAILABLE_MODES)[number];

const FAIL_OPEN_WARNING =
  "SafeNode is unreachable and onUnavailable='fail_open', so actions are being ALLOWED " +
  "without policy evaluation. These results carry degraded=true and no traceId. " +
  "Set onUnavailable='fail_closed' if unevaluated actions must not proceed.";

/** The subset of `console` this SDK uses. Swap it for your own structured logger. */
export interface Logger {
  warn(message: string): void;
}

/** Anything with the shape of the global `fetch`. Inject one for proxies, mTLS, or tests. */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<Response>;

export interface SafeNodeOptions {
  /** Override for self-hosted or staging deployments. Default `https://safenode.tech`. */
  baseUrl?: string;
  /**
   * `"fail_open"` (default), `"fail_closed"`, or `"raise"`.
   * **Read the README section on this before shipping.**
   */
  onUnavailable?: OnUnavailable;
  /** Total request budget in milliseconds. Default 2000. */
  timeout?: number;
  /**
   * Deadline in milliseconds for the server to begin responding. Default 500. Set to `0` to
   * disable it and let `timeout` govern alone. See the README note — `fetch` does not expose the
   * TCP connect phase, so this covers connect *and* time-to-first-byte.
   */
  connectTimeout?: number;
  /** `"redacted"` (default), `"full"`, or `"metadata_only"`. */
  payloadMode?: PayloadMode;
  /** Custom {@link Redactor}. */
  redactor?: Redactor;
  /** Retries on 429-throttle and 5xx. **Default 0.** Never applies to timeouts. */
  retries?: number;
  /** Context merged into every request. */
  staticContext?: Record<string, unknown>;
  /** Optional; normally the API key already identifies the agent. */
  agentId?: string;
  /** Salt for `metadata_only` hashes, to prevent cross-tenant correlation. */
  hashSalt?: string;
  /** Injected `fetch`. Defaults to the global. */
  fetch?: FetchLike;
  /** Where the fail-open and degradation warnings go. Defaults to `console`. */
  logger?: Logger;
}

export interface EvaluateOptions {
  /** Overrides the client's `payloadMode` for this call only. */
  payloadMode?: PayloadMode;
  /** Passed through in `context.correlation_id` so you can join decisions to your own logs. */
  correlationId?: string;
  agentId?: string;
  /** Aborts the evaluation from the caller's side. Composes with the SDK's own deadlines. */
  signal?: AbortSignal;
}

export interface GuardOptions extends EvaluateOptions {
  payload?: Record<string, unknown> | null;
  context?: Record<string, unknown> | null;
  /**
   * When true (default) a `warn` proceeds. Set false to treat warnings as blocking.
   * `review` and `deny` always throw.
   */
  allowWarn?: boolean;
}

export type GuardCallback<T> = (result: Result) => T | Promise<T>;

export interface GuardedOptions<A extends unknown[]> extends EvaluateOptions {
  /** Maps the call arguments to a payload. Without it, nothing about the arguments is sent. */
  payload?: (...args: A) => Record<string, unknown>;
  /** Maps the call arguments to context. Without it, nothing about the arguments is sent. */
  context?: (...args: A) => Record<string, unknown>;
  allowWarn?: boolean;
}

/**
 * Evaluate what your AI agent is about to do, before it does it.
 *
 * ```ts
 * const sn = new SafeNode(process.env.SAFENODE_API_KEY!);
 * const result = await sn.evaluate("send_email", { to: "user@example.com" });
 * if (result.denied) throw new Error(result.reasons.join("; "));
 * ```
 */
export class SafeNode {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly onUnavailable: OnUnavailable;
  readonly timeout: number;
  readonly connectTimeout: number;
  readonly payloadMode: PayloadMode;
  readonly redactor: Redactor;
  readonly retries: number;
  readonly staticContext: Record<string, unknown>;
  readonly agentId: string | null;
  readonly hashSalt: string;

  private readonly fetchImpl: FetchLike;
  private readonly logger: Logger;
  private warnedFailOpen = false;

  constructor(apiKey: string, options: SafeNodeOptions = {}) {
    if (!apiKey || typeof apiKey !== "string") {
      throw new ConfigurationError(
        "apiKey is required. Create one in the SafeNode dashboard and pass it as " +
          "new SafeNode(process.env.SAFENODE_API_KEY).",
      );
    }
    const onUnavailable = options.onUnavailable ?? "fail_open";
    if (!(ON_UNAVAILABLE_MODES as readonly string[]).includes(onUnavailable)) {
      throw new ConfigurationError(
        `onUnavailable must be one of ${JSON.stringify(ON_UNAVAILABLE_MODES)}, ` +
          `got ${JSON.stringify(onUnavailable)}`,
      );
    }
    const payloadMode = options.payloadMode ?? "redacted";
    if (!(PAYLOAD_MODES as readonly string[]).includes(payloadMode)) {
      throw new ConfigurationError(
        `payloadMode must be one of ${JSON.stringify(PAYLOAD_MODES)}, ` +
          `got ${JSON.stringify(payloadMode)}`,
      );
    }
    const retries = options.retries ?? 0;
    if (!Number.isInteger(retries) || retries < 0) {
      throw new ConfigurationError("retries must be an integer >= 0");
    }

    const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (typeof fetchImpl !== "function") {
      throw new ConfigurationError(
        "No global fetch available. Use Node 18+, or pass options.fetch explicitly.",
      );
    }

    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.onUnavailable = onUnavailable;
    this.timeout = options.timeout ?? 2000;
    this.connectTimeout = options.connectTimeout ?? 500;
    this.payloadMode = payloadMode;
    this.redactor = options.redactor ?? new Redactor();
    this.retries = retries;
    this.staticContext = { ...(options.staticContext ?? {}) };
    this.agentId = options.agentId ?? null;
    this.hashSalt = options.hashSalt ?? "";
    this.fetchImpl = fetchImpl;
    this.logger = options.logger ?? console;
  }

  private get url(): string {
    return `${this.baseUrl}${EVALUATE_PATH}`;
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": `safenode-js/${VERSION}`,
    };
  }

  /**
   * Return the exact JSON body that {@link evaluate} would send.
   *
   * This is a dry run: no network call, no side effects. Use it to satisfy yourself about what
   * leaves your infrastructure.
   *
   * ```ts
   * sn.buildRequest("send_email", { to: "a@b.com" }).payload; // { to: "[REDACTED:email]" }
   * ```
   */
  buildRequest(
    actionType: string,
    payload?: Record<string, unknown> | null,
    context?: Record<string, unknown> | null,
    options: EvaluateOptions = {},
  ): EvaluateRequestBody {
    return buildEnvelope({
      actionType,
      payload: payload ?? null,
      context: context ?? null,
      payloadMode: options.payloadMode ?? this.payloadMode,
      redactor: this.redactor,
      correlationId: options.correlationId ?? null,
      agentId: options.agentId ?? this.agentId,
      staticContext: this.staticContext,
      hashSalt: this.hashSalt,
    }).body;
  }

  /**
   * Evaluate an action against policy.
   *
   * A `deny` is a normal return value, not an exception — check `result.denied`. Use
   * {@link guard} if you would rather it threw.
   */
  async evaluate(
    actionType: string,
    payload?: Record<string, unknown> | null,
    context?: Record<string, unknown> | null,
    options: EvaluateOptions = {},
  ): Promise<Result> {
    const body = this.buildRequest(actionType, payload, context, options);
    let attempt = 0;

    for (;;) {
      try {
        return await this.send(body, options.signal);
      } catch (error) {
        if (
          error instanceof AuthError ||
          error instanceof ValidationError ||
          error instanceof QuotaExceededError ||
          error instanceof PolicyDenied
        ) {
          throw error;
        }
        if (error instanceof RateLimitError || error instanceof Unavailable) {
          if (this.shouldRetry(error, attempt)) {
            await sleep(this.backoff(attempt, error));
            attempt += 1;
            continue;
          }
          if (error instanceof RateLimitError) throw error;
          return this.handleUnavailable(error);
        }
        throw error;
      }
    }
  }

  /**
   * Fire an evaluation without awaiting the decision.
   *
   * For audit-and-alert, not gating: you get no decision back, so this cannot stop an action.
   * Errors are swallowed and logged — a SafeNode failure must never surface in your application as
   * an unhandled rejection.
   */
  evaluateNoWait(
    actionType: string,
    payload?: Record<string, unknown> | null,
    context?: Record<string, unknown> | null,
    options: EvaluateOptions = {},
  ): Promise<void> {
    return this.evaluate(actionType, payload, context, options).then(
      () => undefined,
      (error: unknown) => {
        this.logger.warn(`Background SafeNode evaluation failed: ${describe(error)}`);
      },
    );
  }

  /**
   * Evaluate, throw {@link PolicyDenied} if blocked, otherwise run `fn` with the result and return
   * whatever `fn` returns.
   *
   * JavaScript has no `with` statement, so this is the idiomatic equivalent of Python's
   * `with sn.guard(...) as decision:` context manager.
   *
   * ```ts
   * const traceId = await sn.guard("send_email", { payload: { to: addr } }, async (decision) => {
   *   await send(addr);
   *   return decision.traceId;
   * });
   * ```
   */
  async guard<T>(actionType: string, fn: GuardCallback<T>): Promise<T>;
  async guard<T>(actionType: string, options: GuardOptions, fn: GuardCallback<T>): Promise<T>;
  async guard<T>(
    actionType: string,
    optionsOrFn: GuardOptions | GuardCallback<T>,
    maybeFn?: GuardCallback<T>,
  ): Promise<T> {
    const options: GuardOptions = typeof optionsOrFn === "function" ? {} : optionsOrFn;
    const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
    if (typeof fn !== "function") {
      throw new TypeError("guard() requires a callback: guard(actionType, [options], fn)");
    }

    const result = await this.evaluate(
      actionType,
      options.payload ?? null,
      options.context ?? null,
      options,
    );
    enforce(result, options.allowWarn ?? true);
    return await fn(result);
  }

  /**
   * Wrap a function so it is evaluated before it runs. The JavaScript equivalent of Python's
   * `@sn.guarded(...)` decorator.
   *
   * `payload` and `context` are mappers over the call arguments. Without a mapper, nothing of the
   * arguments is sent — deliberate, so wrapping a function never leaks its arguments by accident.
   *
   * ```ts
   * const sendEmail = sn.guarded(
   *   "send_email",
   *   async (to: string, body: string) => { ... },
   *   { payload: (to) => ({ to }) },
   * );
   * ```
   */
  guarded<A extends unknown[], R>(
    actionType: string,
    fn: (...args: A) => R | Promise<R>,
    options: GuardedOptions<A> = {},
  ): (...args: A) => Promise<R> {
    return async (...args: A): Promise<R> => {
      const result = await this.evaluate(
        actionType,
        options.payload ? options.payload(...args) : null,
        options.context ? options.context(...args) : null,
        options,
      );
      enforce(result, options.allowWarn ?? true);
      return await fn(...args);
    };
  }

  // -- transport --------------------------------------------------------------

  private async send(body: EvaluateRequestBody, userSignal?: AbortSignal): Promise<Result> {
    const controller = new AbortController();
    let cause: Error | null = null;

    const abortWith = (message: string) => () => {
      if (cause === null) {
        cause = new Error(message);
        controller.abort();
      }
    };

    const totalSignal = AbortSignal.timeout(this.timeout);
    const onTotal = abortWith(`SafeNode request exceeded the ${this.timeout}ms total timeout`);
    totalSignal.addEventListener("abort", onTotal, { once: true });

    const connectSignal =
      this.connectTimeout > 0 && this.connectTimeout < this.timeout
        ? AbortSignal.timeout(this.connectTimeout)
        : null;
    const onConnect = abortWith(
      `SafeNode did not begin responding within the ${this.connectTimeout}ms connect timeout`,
    );
    connectSignal?.addEventListener("abort", onConnect, { once: true });

    const onExternal = abortWith("SafeNode request aborted by the caller");
    userSignal?.addEventListener("abort", onExternal, { once: true });

    // The deadline is enforced here, not delegated. A `fetch` implementation that ignores its
    // signal — a proxy wrapper, an instrumented client — must not be able to hang a call that sits
    // in front of a user action. Racing makes the timeout a wall-clock guarantee.
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(cause ?? new Error("SafeNode request aborted")),
        { once: true },
      );
    });

    try {
      let response: Response;
      try {
        response = await Promise.race([
          this.fetchImpl(this.url, {
            method: "POST",
            headers: this.headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          }),
          aborted,
        ]);
      } finally {
        // The connect deadline covers the pre-response phase only.
        connectSignal?.removeEventListener("abort", onConnect);
      }

      const text = await Promise.race([response.text(), aborted]);
      return this.parseResponse(response, decode(text));
    } catch (error) {
      if (error instanceof SafeNodeError) throw error;
      const reason: Error = cause ?? (error instanceof Error ? error : new Error(String(error)));
      // Timeouts and transport failures. Never retried — see shouldRetry().
      throw new Unavailable(`Request to SafeNode failed: ${reason.message}`, { cause: reason });
    } finally {
      totalSignal.removeEventListener("abort", onTotal);
      userSignal?.removeEventListener("abort", onExternal);
    }
  }

  /**
   * Turn an HTTP response into a Result, or throw the right typed error.
   *
   * 5xx throws {@link Unavailable} so it flows into the configured fail mode; 4xx throws a
   * specific error, because a misconfigured client should be loud rather than degraded.
   */
  private parseResponse(response: Response, body: Record<string, unknown>): Result {
    const status = response.status;

    if (status === 200) return Result.fromApi(body);

    const message =
      typeof body["message"] === "string" && body["message"]
        ? body["message"]
        : `SafeNode returned HTTP ${status}`;

    if (status === 401) throw new AuthError(message, { statusCode: status, body });

    if (status === 422) {
      // Two shapes share this status: validation failures carry an `errors` object, the
      // oversize-payload rejection does not.
      if (!("errors" in body)) {
        throw new PayloadTooLargeError(message, { statusCode: status, body });
      }
      throw new ValidationError(message, { statusCode: status, body });
    }

    if (status === 429) {
      // Both throttling and monthly-quota exhaustion return 429. Only the first is retryable; the
      // second stays failing until the next billing month. `evaluations_cap` is the discriminator.
      if ("evaluations_cap" in body) {
        throw new QuotaExceededError(message, { statusCode: status, body });
      }
      throw new RateLimitError(message, {
        statusCode: status,
        body,
        retryAfter: retryAfterSeconds(response),
      });
    }

    if (status >= 500) throw new Unavailable(message);

    throw new SafeNodeError(`Unexpected SafeNode response (HTTP ${status}): ${message}`);
  }

  /**
   * Retries are opt-in and deliberately narrow.
   *
   * Never retry a timeout or transport error: every evaluate call is a server-side write, so a
   * request that timed out may well have been recorded. Retrying it double-counts the customer's
   * metered usage and duplicates their decision feed — while also doubling the worst-case latency
   * of a call that sits in front of a user action.
   */
  private shouldRetry(error: unknown, attempt: number): boolean {
    if (attempt >= this.retries) return false;
    if (error instanceof RateLimitError) return true;
    return error instanceof Unavailable && error.cause === undefined;
  }

  private backoff(attempt: number, error: unknown): number {
    if (error instanceof RateLimitError && error.retryAfter) return error.retryAfter * 1000;
    // Full jitter: avoids a fleet of agents retrying in lockstep after a blip.
    return Math.random() * Math.min(2000, 100 * 2 ** attempt);
  }

  /** Apply the configured fail mode. The single most consequential line of config. */
  private handleUnavailable(error: Unavailable): Result {
    if (this.onUnavailable === "raise") throw error;

    const decision = this.onUnavailable === "fail_open" ? "allow" : "deny";

    if (this.onUnavailable === "fail_open" && !this.warnedFailOpen) {
      this.warnedFailOpen = true;
      this.logger.warn(FAIL_OPEN_WARNING);
    }

    this.logger.warn(
      `SafeNode unavailable; returning degraded '${decision}'. cause=${error.message}`,
    );
    return Result.degradedResult(decision);
  }
}

function enforce(result: Result, allowWarn: boolean): void {
  if (result.blocked || (result.warned && !allowWarn)) throw new PolicyDenied(result);
}

function decode(text: string): Record<string, unknown> {
  if (!text) return {};
  try {
    const data: unknown = JSON.parse(text);
    return typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function retryAfterSeconds(response: Response): number | null {
  const raw = response.headers?.get?.("Retry-After");
  if (raw === null || raw === undefined) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
