/** Result types returned by `SafeNode.evaluate()`. */

/**
 * The decision values the server can return, as a type. Closed set — unlike `actionType`, which
 * is free-form and must stay a plain `string`.
 */
export type Decision = "allow" | "warn" | "review" | "deny";

/** The four decisions the server can return. Closed set, unlike `actionType`. */
export const DECISIONS = ["allow", "warn", "review", "deny"] as const;

/**
 * A suggested safer option.
 *
 * `type` is one of `region`, `vendor`, `cost`, `sensitive_data`, `general`.
 *
 * Note that the server never returns an empty alternatives list — a `general` suggestion is
 * appended when nothing more specific applies, including on `allow`. Do not treat a non-empty
 * `alternatives` as evidence that something was wrong.
 */
export interface Alternative {
  type: string;
  description: string;
  /** `payload_snippet` on the wire. `null` when the server did not supply one. */
  payloadSnippet: Record<string, unknown> | null;
}

/** A policy that matched. Empty on hard-rule denials — use `reasons` for attribution there. */
export interface MatchedPolicy {
  rule_id: string;
  [key: string]: unknown;
}

/** Marker put on `reasons` when a result was synthesised locally. */
export const DEGRADED_REASON = "safenode_unavailable";

/**
 * The outcome of an evaluation.
 *
 * Branch on the boolean getters (`allowed`, `denied`, `warned`, `needsReview`) rather than
 * comparing `decision` strings.
 *
 * **Always check `degraded`.** A degraded result is synthesised locally because SafeNode was
 * unreachable — it is *not* a policy decision, and reporting it as one would overstate your
 * coverage.
 */
export class Result {
  readonly decision: string;
  /** 0–100. */
  readonly impactScore: number;
  /** 0–100. */
  readonly riskScore: number;
  readonly matchedPolicies: MatchedPolicy[];
  readonly reasons: string[];
  readonly alternatives: Alternative[];
  /**
   * Server-assigned UUID for this evaluation (bare, no prefix). `null` on degraded results, which
   * were never seen by the server and therefore have nothing to correlate against.
   */
  readonly traceId: string | null;
  /** True when this result was synthesised locally because SafeNode was unreachable. */
  readonly degraded: boolean;
  /**
   * The raw decoded JSON body, for forward compatibility. Empty object on degraded results.
   * The API is additive-only within v1, so new server fields appear here before the SDK models
   * them.
   */
  readonly raw: Record<string, unknown>;

  constructor(init: {
    decision: string;
    impactScore: number;
    riskScore: number;
    matchedPolicies?: MatchedPolicy[];
    reasons?: string[];
    alternatives?: Alternative[];
    traceId?: string | null;
    degraded?: boolean;
    raw?: Record<string, unknown>;
  }) {
    this.decision = init.decision;
    this.impactScore = init.impactScore;
    this.riskScore = init.riskScore;
    this.matchedPolicies = init.matchedPolicies ?? [];
    this.reasons = init.reasons ?? [];
    this.alternatives = init.alternatives ?? [];
    this.traceId = init.traceId ?? null;
    this.degraded = init.degraded ?? false;
    this.raw = init.raw ?? {};
  }

  /** True for `allow`. Note this is false for `warn` — see {@link permitted}. */
  get allowed(): boolean {
    return this.decision === "allow";
  }

  get warned(): boolean {
    return this.decision === "warn";
  }

  get needsReview(): boolean {
    return this.decision === "review";
  }

  get denied(): boolean {
    return this.decision === "deny";
  }

  /**
   * True when the action may proceed under a warn-tolerant policy (`allow` or `warn`).
   *
   * Provided because `if (result.allowed)` silently blocks every `warn`, which is rarely what
   * people mean on first use. Choose deliberately between the two.
   */
  get permitted(): boolean {
    return this.decision === "allow" || this.decision === "warn";
  }

  /** True when the action must not proceed (`deny` or `review`). */
  get blocked(): boolean {
    return this.decision === "deny" || this.decision === "review";
  }

  /** @internal */
  static fromApi(data: Record<string, unknown>): Result {
    const rawAlts = data["alternatives"];
    const rawMatched = data["matched_policies"];
    const rawReasons = data["reasons"];
    const traceId = data["trace_id"];
    return new Result({
      decision: typeof data["decision"] === "string" ? data["decision"] : "",
      impactScore: asNumber(data["impact_score"]),
      riskScore: asNumber(data["risk_score"]),
      matchedPolicies: Array.isArray(rawMatched)
        ? (rawMatched.filter(isPlainObject) as MatchedPolicy[])
        : [],
      reasons: Array.isArray(rawReasons) ? rawReasons.map((r) => String(r)) : [],
      alternatives: Array.isArray(rawAlts) ? rawAlts.map(alternativeFromApi) : [],
      traceId: traceId === null || traceId === undefined ? null : String(traceId),
      degraded: false,
      raw: data,
    });
  }

  /**
   * Synthesise a local result for when SafeNode could not be reached.
   *
   * Deliberately distinguishable from a real decision in three independent ways: `degraded` is
   * true, `traceId` is null, and `reasons` carries a machine-readable marker. Any one of them is
   * enough to filter these out of policy reporting.
   *
   * @internal
   */
  static degradedResult(decision: string, reason: string = DEGRADED_REASON): Result {
    return new Result({
      decision,
      impactScore: 0,
      riskScore: 0,
      matchedPolicies: [],
      reasons: [reason],
      alternatives: [],
      traceId: null,
      degraded: true,
      raw: {},
    });
  }
}

function alternativeFromApi(data: unknown): Alternative {
  if (!isPlainObject(data)) {
    return { type: "unknown", description: String(data), payloadSnippet: null };
  }
  const snippet = data["payload_snippet"];
  return {
    type: data["type"] === undefined ? "unknown" : String(data["type"]),
    description: data["description"] === undefined ? "" : String(data["description"]),
    payloadSnippet: isPlainObject(snippet) ? snippet : null,
  };
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
