/**
 * Builds the request body, applying the chosen payload mode.
 *
 * Kept separate from the client so `buildRequest()` (the dry run) can show you exactly what would
 * leave your process without any network machinery involved.
 */

import { Redactor } from "./redaction.js";
import { sha256Hex } from "./sha256.js";

export const PAYLOAD_MODES = ["full", "redacted", "metadata_only"] as const;
export type PayloadMode = (typeof PAYLOAD_MODES)[number];

/**
 * Context keys the SDK owns. Sent on every request so server-side policy can reason about what the
 * client did to the payload before sending it.
 */
export const CONTEXT_PAYLOAD_MODE = "safenode_payload_mode";
export const CONTEXT_REDACTIONS = "safenode_redactions";
export const CONTEXT_CORRELATION_ID = "correlation_id";

const MAX_DEPTH = 64;

/** The exact JSON body POSTed to `/api/v1/evaluate`. Nothing is added downstream. */
export interface EvaluateRequestBody {
  /** Free-form, not an enum. Rules match on exact strings. */
  action_type: string;
  payload: unknown;
  context: Record<string, unknown>;
  agent_id?: string;
}

/**
 * Mirrors Python's `repr()` for the leaf types a JSON payload can hold, so that the same value
 * hashes to the same digest in both SDKs. Exact for strings, booleans, null and integers; a float
 * that happens to be integral (`1.0`) is indistinguishable from an integer in JavaScript and will
 * differ from Python's `1.0`.
 */
export function pythonRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "nan";
    if (value === Infinity) return "inf";
    if (value === -Infinity) return "-inf";
    return String(value);
  }
  if (typeof value === "string") {
    const escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    if (escaped.includes("'") && !escaped.includes('"')) return `"${escaped}"`;
    return `'${escaped.replace(/'/g, "\\'")}'`;
  }
  return JSON.stringify(value) ?? "None";
}

function hashValue(value: unknown, salt: string): string {
  return `sha256:${sha256Hex(salt + pythonRepr(value)).slice(0, 16)}`;
}

/**
 * Replace every leaf value with a hash while preserving the key structure.
 *
 * Keys are preserved deliberately. SafeNode's `sensitive_data` rule can match on key *names*
 * (`forbidden_keys`), so flattening the payload into an opaque blob would silently disable it —
 * the same class of bug that redaction-without-reporting causes.
 */
function hashTree(node: unknown, salt: string, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "sha256:truncated";
  if (Array.isArray(node)) return node.map((item) => hashTree(item, salt, depth + 1));
  if (typeof node === "object" && node !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      out[key] = hashTree(value, salt, depth + 1);
    }
    return out;
  }
  return hashValue(node, salt);
}

export interface BuildEnvelopeOptions {
  actionType: string;
  payload?: Record<string, unknown> | null;
  context?: Record<string, unknown> | null;
  payloadMode?: PayloadMode;
  redactor?: Redactor | null;
  correlationId?: string | null;
  agentId?: string | null;
  staticContext?: Record<string, unknown> | null;
  hashSalt?: string;
}

export interface Envelope {
  body: EvaluateRequestBody;
  counts: Record<string, number>;
}

/** Return the request body plus the redaction counts embedded in it. */
export function buildEnvelope(options: BuildEnvelopeOptions): Envelope {
  const payloadMode = options.payloadMode ?? "redacted";
  if (!(PAYLOAD_MODES as readonly string[]).includes(payloadMode)) {
    throw new TypeError(
      `payloadMode must be one of ${JSON.stringify(PAYLOAD_MODES)}, got ${JSON.stringify(payloadMode)}`,
    );
  }

  const payload: Record<string, unknown> = options.payload ? { ...options.payload } : {};
  const mergedContext: Record<string, unknown> = options.staticContext
    ? { ...options.staticContext }
    : {};
  if (options.context) Object.assign(mergedContext, options.context);

  let counts: Record<string, number> = {};
  let outPayload: unknown;

  if (payloadMode === "full") {
    outPayload = payload;
  } else if (payloadMode === "redacted") {
    const active = options.redactor ?? new Redactor();
    const report = active.redact(payload);
    outPayload = report.data;
    counts = report.counts;
  } else {
    // metadata_only: count what *would* have been redacted, so policy keeps the same signal it
    // gets in "redacted" mode. Then send hashes instead of values.
    const active = options.redactor ?? new Redactor();
    counts = active.redact(payload).counts;
    outPayload = hashTree(payload, options.hashSalt ?? "");
  }

  // Context is sent as-is in every mode: the rules engine is overwhelmingly context-driven, and
  // redacting it would break vendor/region/spend gating outright.
  mergedContext[CONTEXT_PAYLOAD_MODE] = payloadMode;
  mergedContext[CONTEXT_REDACTIONS] = counts;
  if (options.correlationId !== undefined && options.correlationId !== null) {
    mergedContext[CONTEXT_CORRELATION_ID] = options.correlationId;
  }

  const body: EvaluateRequestBody = {
    action_type: options.actionType,
    payload: outPayload,
    context: mergedContext,
  };
  if (options.agentId !== undefined && options.agentId !== null) {
    body.agent_id = options.agentId;
  }

  return { body, counts };
}
