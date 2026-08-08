/**
 * Client-side redaction.
 *
 * Runs in your process, before the request leaves it. Replaced values become `[REDACTED:<type>]`.
 *
 * The redactor also *counts* what it removed. Those counts are sent to SafeNode in
 * `context.safenode_redactions` so policy can still act on the presence of sensitive data without
 * ever receiving it — see the note below.
 *
 * ## Why counts are always sent
 *
 * SafeNode's server-side `sensitive_data` rule matches regexes against payload *values*. If the
 * SDK scrubbed those values first and said nothing, a policy of "deny any action containing a card
 * number" would silently start passing — the client-side privacy feature would disable the
 * server-side security control.
 *
 * Reporting counts closes that gap. Pair a `sensitive_data` pattern rule with a
 * `redaction_metadata` rule covering the same types.
 *
 * These counts are self-reported. They raise the floor for honest clients; they are not a defence
 * against a hostile one, which could simply send an empty payload.
 */

const MAX_DEPTH = 64;

/**
 * A named pattern to strip from string values.
 *
 * `validator` optionally rejects false positives — the credit-card rule uses it to require a
 * passing Luhn checksum, so order numbers and long digit strings survive intact.
 */
export interface RedactionRule {
  name: string;
  pattern: RegExp;
  validator?: (candidate: string) => boolean;
}

/** Construct a rule. Ensures the pattern is global so every occurrence is replaced. */
export function redactionRule(
  name: string,
  pattern: RegExp,
  validator?: (candidate: string) => boolean,
): RedactionRule {
  const rule: RedactionRule = { name, pattern: ensureGlobal(pattern) };
  if (validator) rule.validator = validator;
  return rule;
}

function ensureGlobal(pattern: RegExp): RegExp {
  return pattern.flags.includes("g")
    ? pattern
    : new RegExp(pattern.source, `${pattern.flags}g`);
}

export function replacementFor(name: string): string {
  return `[REDACTED:${name}]`;
}

/** @internal */
export function luhnOk(candidate: string): boolean {
  const digits: number[] = [];
  for (const char of candidate) {
    if (char >= "0" && char <= "9") digits.push(char.charCodeAt(0) - 48);
  }
  if (digits.length < 13 || digits.length > 19) return false;
  let checksum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = digits[digits.length - 1 - index] as number;
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    checksum += digit;
  }
  return checksum % 10 === 0;
}

/**
 * The default ruleset. Order matters — earlier rules win on overlapping matches, so the most
 * specific patterns (private keys, provider-issued API keys) run before the general ones.
 */
export const DEFAULT_RULES: readonly RedactionRule[] = Object.freeze([
  redactionRule(
    "private_key",
    /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
  ),
  redactionRule(
    "api_key",
    new RegExp(
      "\\b(?:" +
        "sk-[A-Za-z0-9_-]{16,}" + // OpenAI and lookalikes
        "|ghp_[A-Za-z0-9]{36}" + // GitHub personal access token
        "|gho_[A-Za-z0-9]{36}" +
        "|ghs_[A-Za-z0-9]{36}" +
        "|github_pat_[A-Za-z0-9_]{22,}" +
        "|xox[baprs]-[A-Za-z0-9-]{10,}" + // Slack
        "|AKIA[0-9A-Z]{16}" + // AWS access key id
        "|AIza[A-Za-z0-9_-]{35}" + // Google API key
        "|sn_[A-Za-z0-9]{16,}" + // SafeNode's own keys
        ")\\b",
      "g",
    ),
  ),
  redactionRule("bearer_token", /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi),
  redactionRule("email", /\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g),
  redactionRule("credit_card", /\b(?:\d[ -]?){12,18}\d\b/g, luhnOk),
  redactionRule("us_ssn", /\b(?!000|666|9\d\d)\d{3}-\d{2}-\d{4}\b/g),
  redactionRule(
    "phone",
    /(?<![\w-])(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4}(?![\w-])/g,
  ),
]);

/** What a redaction pass produced. */
export interface RedactionReport<T = unknown> {
  data: T;
  counts: Record<string, number>;
  /** True when anything at all was stripped. */
  redactedAnything: boolean;
}

export interface RedactorOptions {
  /** Replaces the default ruleset entirely. Use `extraRules` to add instead. */
  rules?: readonly RedactionRule[];
  /** Appended to the active ruleset. */
  extraRules?: readonly RedactionRule[];
  /**
   * Object keys whose values are never redacted, compared case-insensitively. Use for fields you
   * know are safe and need intact for policy — for example a `vendor_id` that looks like a token.
   */
  allowlistKeys?: readonly string[];
  /** Names of default rules to switch off. */
  disabledRules?: readonly string[];
  /**
   * Object keys whose values are *always* fully replaced regardless of content. Use for fields you
   * know are sensitive but whose format no pattern catches.
   */
  redactKeys?: readonly string[];
}

/**
 * Strips sensitive values from payloads before they leave the process.
 *
 * Keys are never redacted, only values — SafeNode's `sensitive_data` rule can match on key names
 * (`forbidden_keys`), and destroying them would break that.
 *
 * ```ts
 * new Redactor().redact({ to: "a@b.com" }).data; // { to: "[REDACTED:email]" }
 * ```
 */
export class Redactor {
  readonly rules: RedactionRule[];
  readonly allowlistKeys: Set<string>;
  readonly redactKeys: Set<string>;

  constructor(options: RedactorOptions = {}) {
    let base = options.rules !== undefined ? [...options.rules] : [...DEFAULT_RULES];
    if (options.disabledRules && options.disabledRules.length > 0) {
      const off = new Set(options.disabledRules.map((name) => name.toLowerCase()));
      base = base.filter((rule) => !off.has(rule.name.toLowerCase()));
    }
    if (options.extraRules) base.push(...options.extraRules);
    this.rules = base.map((rule) => ({ ...rule, pattern: ensureGlobal(rule.pattern) }));
    this.allowlistKeys = new Set((options.allowlistKeys ?? []).map((k) => k.toLowerCase()));
    this.redactKeys = new Set((options.redactKeys ?? []).map((k) => k.toLowerCase()));
  }

  /** Return a redacted deep copy of `data` plus per-type counts. `data` is not mutated. */
  redact<T>(data: T): RedactionReport<T> {
    const counts: Record<string, number> = {};
    const cleaned = this.walk(data, counts, 0) as T;
    return { data: cleaned, counts, redactedAnything: Object.keys(counts).length > 0 };
  }

  /** Redact a bare string. */
  redactText(text: string): RedactionReport<string> {
    const counts: Record<string, number> = {};
    const cleaned = this.scrub(text, counts);
    return { data: cleaned, counts, redactedAnything: Object.keys(counts).length > 0 };
  }

  private walk(node: unknown, counts: Record<string, number>, depth: number): unknown {
    if (depth > MAX_DEPTH) {
      // Cyclic or pathologically nested input. Refuse to recurse further rather than
      // overflowing the stack inside the caller's request path.
      return "[REDACTED:truncated]";
    }

    if (Array.isArray(node)) {
      return node.map((item) => this.walk(item, counts, depth + 1));
    }

    if (typeof node === "string") {
      return this.scrub(node, counts);
    }

    if (typeof node === "object" && node !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        const lowered = String(key).toLowerCase();
        if (this.redactKeys.has(lowered)) {
          out[key] = "[REDACTED:key]";
          counts["key"] = (counts["key"] ?? 0) + 1;
        } else if (this.allowlistKeys.has(lowered)) {
          out[key] = value;
        } else {
          out[key] = this.walk(value, counts, depth + 1);
        }
      }
      return out;
    }

    return node;
  }

  private scrub(text: string, counts: Record<string, number>): string {
    let current = text;
    for (const rule of this.rules) {
      let hits = 0;
      const replacement = replacementFor(rule.name);
      rule.pattern.lastIndex = 0;
      current = current.replace(rule.pattern, (match: string) => {
        if (rule.validator && !rule.validator(match)) return match;
        hits += 1;
        return replacement;
      });
      if (hits > 0) counts[rule.name] = (counts[rule.name] ?? 0) + hits;
    }
    return current;
  }
}
