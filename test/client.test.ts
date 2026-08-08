import { describe, expect, it } from "vitest";

import {
  AuthError,
  ConfigurationError,
  PayloadTooLargeError,
  PolicyDenied,
  QuotaExceededError,
  RateLimitError,
  SafeNode,
  Unavailable,
  ValidationError,
  type SafeNodeOptions,
} from "../src/index.js";
import {
  ALLOW_BODY,
  API_KEY,
  bodyWith,
  CapturingLogger,
  jsonResponse,
  mockFetch,
} from "./helpers.js";

function client(
  options: Parameters<typeof mockFetch>[0] = {},
  clientOptions: Partial<SafeNodeOptions> = {},
) {
  const { fetch, recorder } = mockFetch(options);
  const logger = new CapturingLogger();
  const sn = new SafeNode(API_KEY, { fetch, logger, ...clientOptions });
  return { sn, recorder, logger };
}

const boom = () => {
  throw new TypeError("fetch failed: connection refused");
};

describe("configuration", () => {
  it("fails at construction without an api key", () => {
    expect(() => new SafeNode("")).toThrow(ConfigurationError);
    expect(() => new SafeNode("")).toThrow(/apiKey/);
  });

  it("fails at construction on a bad fail mode", () => {
    expect(() => new SafeNode(API_KEY, { onUnavailable: "fail_sideways" as never })).toThrow(
      /onUnavailable/,
    );
  });

  it("fails at construction on a bad payload mode", () => {
    expect(() => new SafeNode(API_KEY, { payloadMode: "raw" as never })).toThrow(/payloadMode/);
  });

  it("fails at construction on negative retries", () => {
    expect(() => new SafeNode(API_KEY, { retries: -1 })).toThrow(/retries/);
  });

  it("has the documented defaults", () => {
    const sn = new SafeNode(API_KEY);
    expect(sn.onUnavailable).toBe("fail_open");
    expect(sn.payloadMode).toBe("redacted");
    expect(sn.retries).toBe(0);
    expect(sn.timeout).toBe(2000);
    expect(sn.connectTimeout).toBe(500);
    expect(sn.baseUrl).toBe("https://safenode.tech");
  });
});

describe("request shape", () => {
  it("sends bearer auth and a user agent", async () => {
    const { sn, recorder } = client();
    await sn.evaluate("send_email");
    expect(recorder.last.headers["Authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(recorder.last.headers["User-Agent"]).toMatch(/^safenode-js\//);
  });

  it("posts to the v1 evaluate path", async () => {
    const { sn, recorder } = client();
    await sn.evaluate("send_email");
    expect(recorder.last.url).toBe("https://safenode.tech/api/v1/evaluate");
    expect(recorder.last.method).toBe("POST");
  });

  it("honours a baseUrl override and strips trailing slashes", async () => {
    const { sn, recorder } = client({}, { baseUrl: "https://staging.example.com/" });
    await sn.evaluate("x");
    expect(recorder.last.url).toBe("https://staging.example.com/api/v1/evaluate");
  });

  it("redacts the payload by default", async () => {
    const { sn, recorder } = client();
    await sn.evaluate("send_email", { to: "alice@example.com" });
    expect(recorder.last.body).not.toContain("alice@example.com");
  });

  it("treats action_type as free-form", async () => {
    const { sn, recorder } = client();
    await sn.evaluate("some.custom/action-99");
    expect(recorder.lastBody["action_type"]).toBe("some.custom/action-99");
  });
});

describe("success parsing", () => {
  it("parses an allow", async () => {
    const { sn } = client();
    const result = await sn.evaluate("x");
    expect(result.decision).toBe("allow");
    expect(result.allowed && result.permitted && !result.blocked).toBe(true);
    expect(result.traceId).toBe(ALLOW_BODY["trace_id"]);
    expect(result.degraded).toBe(false);
  });

  it("returns a deny rather than throwing", async () => {
    const { sn } = client({
      responses: [() => jsonResponse(200, bodyWith({ decision: "deny", reasons: ["nope"] }))],
    });
    const result = await sn.evaluate("x");
    expect(result.denied && result.blocked).toBe(true);
    expect(result.reasons).toEqual(["nope"]);
  });

  it("treats warn as permitted but not allowed", async () => {
    const { sn } = client({ responses: [() => jsonResponse(200, bodyWith({ decision: "warn" }))] });
    const result = await sn.evaluate("x");
    expect(result.warned && result.permitted).toBe(true);
    expect(result.allowed || result.blocked).toBe(false);
  });

  it("treats review as blocked", async () => {
    const { sn } = client({
      responses: [() => jsonResponse(200, bodyWith({ decision: "review" }))],
    });
    const result = await sn.evaluate("x");
    expect(result.needsReview && result.blocked).toBe(true);
  });

  it("parses scores on the 0-100 scale", async () => {
    const { sn } = client({
      responses: [() => jsonResponse(200, bodyWith({ impact_score: 42.5, risk_score: 41.25 }))],
    });
    const result = await sn.evaluate("x");
    expect(result.impactScore).toBe(42.5);
    expect(result.riskScore).toBe(41.25);
  });

  it("parses alternatives", async () => {
    const { sn } = client({
      responses: [
        () =>
          jsonResponse(
            200,
            bodyWith({
              alternatives: [
                { type: "cost", description: "Reduce cost.", payload_snippet: { a: 1 } },
              ],
            }),
          ),
      ],
    });
    const alt = (await sn.evaluate("x")).alternatives[0];
    expect(alt?.type).toBe("cost");
    expect(alt?.payloadSnippet).toEqual({ a: 1 });
  });

  it("nulls a missing payload snippet", async () => {
    const { sn } = client();
    expect((await sn.evaluate("x")).alternatives[0]?.payloadSnippet).toBeNull();
  });

  it("parses matched policies", async () => {
    const { sn } = client({
      responses: [() => jsonResponse(200, bodyWith({ matched_policies: [{ rule_id: "r-1" }] }))],
    });
    expect((await sn.evaluate("x")).matchedPolicies[0]?.rule_id).toBe("r-1");
  });

  it("keeps unknown server fields in raw", async () => {
    // The API is additive-only within v1, so new fields must not break the client.
    const { sn } = client({
      responses: [() => jsonResponse(200, bodyWith({ brand_new_field: "hello" }))],
    });
    expect((await sn.evaluate("x")).raw["brand_new_field"]).toBe("hello");
  });
});

describe("error mapping", () => {
  it("maps 401 to AuthError", async () => {
    const { sn } = client({ responses: [() => jsonResponse(401, { message: "Invalid API key." })] });
    await expect(sn.evaluate("x")).rejects.toThrow(AuthError);
  });

  it("maps 422 with errors to ValidationError", async () => {
    const { sn } = client({
      responses: [
        () => jsonResponse(422, { message: "bad", errors: { action_type: ["required"] } }),
      ],
    });
    const error = await sn.evaluate("x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).not.toBeInstanceOf(PayloadTooLargeError);
    expect((error as ValidationError).errors).toEqual({ action_type: ["required"] });
  });

  it("maps 422 without errors to PayloadTooLargeError", async () => {
    // The size rejection has no `errors` key — that is the only way to tell it apart.
    const { sn } = client({
      responses: [
        () => jsonResponse(422, { message: "Payload or context exceeds maximum size." }),
      ],
    });
    await expect(sn.evaluate("x")).rejects.toThrow(PayloadTooLargeError);
  });

  it("maps 429 throttling to RateLimitError with Retry-After", async () => {
    const { sn } = client({
      responses: [
        () => jsonResponse(429, { message: "Too Many Attempts." }, { "Retry-After": "30" }),
      ],
    });
    const error = await sn.evaluate("x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfter).toBe(30);
  });

  it("maps 429 quota exhaustion to QuotaExceededError, not RateLimitError", async () => {
    // Both are 429. Confusing them means retrying for a month against a hard cap.
    const { sn } = client({
      responses: [
        () =>
          jsonResponse(429, {
            message: "Monthly evaluation limit reached.",
            evaluations_used: 1000,
            evaluations_cap: 1000,
          }),
      ],
    });
    const error = await sn.evaluate("x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(error).not.toBeInstanceOf(RateLimitError);
    expect((error as QuotaExceededError).evaluationsCap).toBe(1000);
    expect((error as QuotaExceededError).evaluationsUsed).toBe(1000);
  });

  it("never retries a quota error", async () => {
    const { sn, recorder } = client(
      { responses: [() => jsonResponse(429, { message: "x", evaluations_cap: 10 })] },
      { retries: 3 },
    );
    await expect(sn.evaluate("x")).rejects.toThrow(QuotaExceededError);
    expect(recorder.count).toBe(1);
  });

  it("throws on an unexpected 4xx", async () => {
    const { sn } = client({ responses: [() => jsonResponse(418, { message: "teapot" })] });
    await expect(sn.evaluate("x")).rejects.toThrow(/Unexpected SafeNode response \(HTTP 418\)/);
  });

  it("survives a non-JSON error body", async () => {
    const { sn } = client({
      responses: [() => new Response("<html>gateway</html>", { status: 401 })],
    });
    await expect(sn.evaluate("x")).rejects.toThrow(/HTTP 401/);
  });
});

describe("fail modes", () => {
  it("fail_open returns a degraded allow", async () => {
    const { sn } = client({ handler: boom }, { onUnavailable: "fail_open" });
    const result = await sn.evaluate("x");
    expect(result.decision).toBe("allow");
    expect(result.degraded).toBe(true);
  });

  it("fail_closed returns a degraded deny", async () => {
    const { sn } = client({ handler: boom }, { onUnavailable: "fail_closed" });
    const result = await sn.evaluate("x");
    expect(result.decision).toBe("deny");
    expect(result.degraded).toBe(true);
  });

  it("raise mode propagates Unavailable", async () => {
    const { sn } = client({ handler: boom }, { onUnavailable: "raise" });
    await expect(sn.evaluate("x")).rejects.toThrow(Unavailable);
  });

  it("degraded results carry no traceId", async () => {
    // A synthetic decision must never look like a real one in anyone's logs.
    const { sn } = client({ handler: boom });
    const result = await sn.evaluate("x");
    expect(result.traceId).toBeNull();
    expect(result.reasons).toEqual(["safenode_unavailable"]);
    expect(result.raw).toEqual({});
    expect(result.matchedPolicies).toEqual([]);
    expect(result.impactScore).toBe(0);
  });

  it("routes 5xx through the fail mode", async () => {
    const { sn } = client(
      { responses: [() => jsonResponse(503, { message: "down" })] },
      { onUnavailable: "fail_closed" },
    );
    const result = await sn.evaluate("x");
    expect(result.denied && result.degraded).toBe(true);
  });

  it("routes a timeout through the fail mode", async () => {
    const { sn } = client({ handler: () => new Promise<Response>(() => {}) }, { timeout: 20 });
    const result = await sn.evaluate("x");
    expect(result.allowed && result.degraded).toBe(true);
  });

  it("applies the connect deadline before the total timeout", async () => {
    const { sn } = client(
      { handler: () => new Promise<Response>(() => {}) },
      { timeout: 5000, connectTimeout: 20 },
    );
    const started = Date.now();
    const result = await sn.evaluate("x");
    expect(result.degraded).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("honours a caller-supplied abort signal", async () => {
    const { sn } = client({ handler: () => new Promise<Response>(() => {}) }, { timeout: 5000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const result = await sn.evaluate("x", null, null, { signal: controller.signal });
    expect(result.degraded).toBe(true);
  });

  it("logs the fail-open warning exactly once", async () => {
    const { sn, logger } = client({ handler: boom });
    await sn.evaluate("x");
    await sn.evaluate("x");
    const warnings = logger.messages.filter((m) => m.includes("without policy evaluation"));
    expect(warnings).toHaveLength(1);
  });
});

describe("retries", () => {
  it("does not retry by default", async () => {
    const { sn, recorder } = client({ responses: [() => jsonResponse(500, {})] });
    await sn.evaluate("x");
    expect(recorder.count).toBe(1);
  });

  it("never retries a timeout even when retries are enabled", async () => {
    // Every evaluate call is a server-side write; a timed-out call may already be recorded.
    const { sn, recorder } = client(
      { handler: () => new Promise<Response>(() => {}) },
      { retries: 3, timeout: 20 },
    );
    await sn.evaluate("x");
    expect(recorder.count).toBe(1);
  });

  it("never retries a transport failure even when retries are enabled", async () => {
    const { sn, recorder } = client({ handler: boom }, { retries: 3 });
    await sn.evaluate("x");
    expect(recorder.count).toBe(1);
  });

  it("retries a 5xx when enabled, then succeeds", async () => {
    const { sn, recorder } = client(
      {
        responses: [
          () => jsonResponse(503, { message: "down" }),
          () => jsonResponse(200, ALLOW_BODY),
        ],
      },
      { retries: 2 },
    );
    const result = await sn.evaluate("x");
    expect(result.allowed && !result.degraded).toBe(true);
    expect(recorder.count).toBe(2);
  });

  it("bounds the retries", async () => {
    const { sn, recorder } = client({ responses: [() => jsonResponse(503, {})] }, { retries: 2 });
    await sn.evaluate("x");
    expect(recorder.count).toBe(3); // initial + 2 retries
  });

  it("retries a 429 throttle when enabled", async () => {
    const { sn, recorder } = client(
      {
        responses: [
          () => jsonResponse(429, { message: "slow down" }),
          () => jsonResponse(200, ALLOW_BODY),
        ],
      },
      { retries: 1 },
    );
    expect((await sn.evaluate("x")).allowed).toBe(true);
    expect(recorder.count).toBe(2);
  });
});

describe("guard", () => {
  it("runs the callback on allow and returns its value", async () => {
    const { sn } = client();
    const out = await sn.guard("x", async (result) => `ok:${result.decision}`);
    expect(out).toBe("ok:allow");
  });

  it("throws PolicyDenied on deny without running the callback", async () => {
    const { sn } = client({
      responses: [() => jsonResponse(200, bodyWith({ decision: "deny", reasons: ["blocked"] }))],
    });
    let ran = false;
    const error = await sn
      .guard("x", async () => {
        ran = true;
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PolicyDenied);
    expect((error as PolicyDenied).reasons).toEqual(["blocked"]);
    expect((error as PolicyDenied).traceId).toBe(ALLOW_BODY["trace_id"]);
    expect(ran).toBe(false);
  });

  it("throws PolicyDenied on review", async () => {
    const { sn } = client({
      responses: [() => jsonResponse(200, bodyWith({ decision: "review" }))],
    });
    await expect(sn.guard("x", async () => undefined)).rejects.toThrow(PolicyDenied);
  });

  it("allows warn by default", async () => {
    const { sn } = client({ responses: [() => jsonResponse(200, bodyWith({ decision: "warn" }))] });
    expect(await sn.guard("x", async (r) => r.warned)).toBe(true);
  });

  it("can treat warn as blocking", async () => {
    const { sn } = client({ responses: [() => jsonResponse(200, bodyWith({ decision: "warn" }))] });
    await expect(sn.guard("x", { allowWarn: false }, async () => undefined)).rejects.toThrow(
      PolicyDenied,
    );
  });

  it("sends the payload and context given in options", async () => {
    const { sn, recorder } = client();
    await sn.guard(
      "send_email",
      { payload: { to: "a@b.com" }, context: { vendor_id: "sendgrid" } },
      async () => undefined,
    );
    expect(recorder.lastBody["payload"]).toEqual({ to: "[REDACTED:email]" });
    expect((recorder.lastBody["context"] as Record<string, unknown>)["vendor_id"]).toBe("sendgrid");
  });

  it("requires a callback", async () => {
    const { sn } = client();
    await expect(sn.guard("x", {}, undefined as never)).rejects.toThrow(TypeError);
  });
});

describe("guarded", () => {
  it("runs the wrapped function on allow", async () => {
    const { sn } = client();
    const send = sn.guarded("send_email", async (to: string) => `sent to ${to}`, {
      payload: (to) => ({ to }),
    });
    expect(await send("a@b.com")).toBe("sent to a@b.com");
  });

  it("does not call the wrapped function on deny", async () => {
    const { sn } = client({
      responses: [() => jsonResponse(200, bodyWith({ decision: "deny" }))],
    });
    const calls: number[] = [];
    const send = sn.guarded("send_email", async () => calls.push(1));
    await expect(send()).rejects.toThrow(PolicyDenied);
    expect(calls).toEqual([]);
  });

  it("sends nothing about the arguments without a mapper", async () => {
    // Wrapping a function must never leak its arguments by accident.
    const { sn, recorder } = client();
    const send = sn.guarded("send_email", async (_secret: string) => undefined);
    await send("hunter2");
    expect(recorder.last.body).not.toContain("hunter2");
  });

  it("maps context when given a mapper", async () => {
    const { sn, recorder } = client();
    const run = sn.guarded("x", async (_v: string) => undefined, {
      context: (v) => ({ vendor_id: v }),
    });
    await run("sendgrid");
    expect((recorder.lastBody["context"] as Record<string, unknown>)["vendor_id"]).toBe("sendgrid");
  });
});

describe("evaluateNoWait", () => {
  it("sends the evaluation and resolves without a decision", async () => {
    const { sn, recorder } = client();
    await expect(sn.evaluateNoWait("x", { a: 1 })).resolves.toBeUndefined();
    expect(recorder.count).toBe(1);
  });

  it("swallows and logs failures", async () => {
    const { sn, logger } = client({ responses: [() => jsonResponse(401, { message: "nope" })] });
    await expect(sn.evaluateNoWait("x")).resolves.toBeUndefined();
    expect(logger.messages.some((m) => m.includes("Background SafeNode evaluation failed"))).toBe(
      true,
    );
  });
});

describe("options passthrough", () => {
  it("passes correlationId through in context", async () => {
    const { sn, recorder } = client();
    await sn.evaluate("x", null, null, { correlationId: "req-42" });
    expect((recorder.lastBody["context"] as Record<string, unknown>)["correlation_id"]).toBe(
      "req-42",
    );
  });

  it("sends agentId when configured", async () => {
    const { sn, recorder } = client({}, { agentId: "agent-7" });
    await sn.evaluate("x");
    expect(recorder.lastBody["agent_id"]).toBe("agent-7");
  });

  it("omits agent_id when not configured", async () => {
    const { sn, recorder } = client();
    await sn.evaluate("x");
    expect("agent_id" in recorder.lastBody).toBe(false);
  });

  it("honours a per-call payloadMode", async () => {
    const { sn, recorder } = client();
    await sn.evaluate("x", { to: "a@b.com" }, null, { payloadMode: "full" });
    expect(recorder.lastBody["payload"]).toEqual({ to: "a@b.com" });
  });

  it("sends payload mode and redaction counts in every mode", async () => {
    for (const mode of ["full", "redacted", "metadata_only"] as const) {
      const { sn, recorder } = client({}, { payloadMode: mode });
      await sn.evaluate("x", { to: "a@b.com" });
      const context = recorder.lastBody["context"] as Record<string, unknown>;
      expect(context["safenode_payload_mode"]).toBe(mode);
      expect(context["safenode_redactions"]).toEqual(mode === "full" ? {} : { email: 1 });
    }
  });
});
