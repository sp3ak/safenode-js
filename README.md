# SafeNode TypeScript SDK

Evaluate what your AI agent is about to do, before it does it.

```bash
npm install safenode-sdk
```

```ts
import { SafeNode } from "safenode-sdk";

const sn = new SafeNode(process.env.SAFENODE_API_KEY!);

const result = await sn.evaluate(
  "send_email",
  { to: "customer@example.com", subject: "Your refund" },
  { vendor_id: "sendgrid", cost_estimate: 0.01 },
);

if (result.denied) {
  throw new Error(`Blocked: ${result.reasons.join("; ")} (trace ${result.traceId})`);
}

await sendTheEmail();
```

That is the whole idea. Your agent proposes an action, SafeNode returns `allow`, `warn`, `review`, or
`deny` based on policies you configure in a dashboard, and your code branches on it.

[Get an API key — free tier, no card](https://safenode.tech) ·
[Docs](https://safenode.tech/docs) ·
[OpenAPI spec](https://safenode.tech/openapi.yaml)

This is the TypeScript port of the [Python SDK](https://pypi.org/project/safenode-sdk/). Same
options, same result fields, same fail modes, same redaction rules — in camelCase.

---

## Contents

- [What this is not](#what-this-is-not)
- [Fail behaviour](#fail-behaviour-read-this-one)
- [Latency](#latency)
- [What data leaves your infrastructure](#what-data-leaves-your-infrastructure)
- [Enforcement helpers](#enforcement-helpers)
- [Non-blocking mode](#non-blocking-mode)
- [Error handling](#error-handling)
- [Why not just write if-statements](#why-not-just-write-if-statements)
- [Why not OPA](#why-not-opa)
- [FAQ](#faq)
- [API reference](#api-reference)

---

## What this is not

Being clear about this up front saves everyone time.

- **Not a jailbreak or prompt-injection detector.** It evaluates *actions*, not prompts. If your
  agent has been talked into wiring money, SafeNode can stop the wire — it will not tell you the
  agent was manipulated.
- **Not a sandbox.** Nothing here contains a process, restricts syscalls, or limits filesystem
  access. It returns a decision; enforcing it is your code's job. (The
  [MCP gateway](https://safenode.tech/docs) is the exception — it enforces by not forwarding.)
- **Not a local rules engine.** Every `evaluate()` is a network call. There is no offline mode and
  no local policy evaluation.
- **Not a replacement for authz.** SafeNode answers "should this action happen at all, under these
  circumstances", not "is this user allowed to do this". You still need both.
- **Not free of side effects.** Every evaluation is recorded server-side and counts against your
  monthly allowance.

---

## Fail behaviour (read this one)

The single most consequential setting. When SafeNode is unreachable — network error, timeout, or a
5xx — the SDK does one of three things:

| `onUnavailable` | Behaviour |
| --- | --- |
| `"fail_open"` **(default)** | Returns a synthetic `allow` with `degraded: true`. Your agent keeps working, unevaluated. |
| `"fail_closed"` | Returns a synthetic `deny` with `degraded: true`. Your agent stops. |
| `"raise"` | Throws `Unavailable` and lets you decide. |

**The default is `fail_open`, and that is a deliberate tradeoff.** A security tool that takes your
production down during its own first outage does not get a second chance. But it means a SafeNode
outage silently becomes an unpoliced window.

Choose per action class rather than globally. That is usually the right answer:

```ts
const audit = new SafeNode(key, { onUnavailable: "fail_open" }); // read-only, logging
const gate = new SafeNode(key, { onUnavailable: "fail_closed" }); // payments, deletions, mail
```

Degraded results are distinguishable from real decisions in three independent ways, so they can
never be quietly counted as policy allows:

```ts
result.degraded === true;
result.traceId === null; // a real decision always has one
result.reasons; // ["safenode_unavailable"]
```

The SDK also logs a one-time warning the first time it fails open. Pass a `logger` to route that
into your own structured logging instead of `console`.

---

## Latency

Client-side budget, both configurable:

| | Default |
| --- | --- |
| Total request timeout | **2000 ms** |
| Connect timeout | **500 ms** |
| Retries | **0** |

```ts
const sn = new SafeNode(key, { timeout: 750, connectTimeout: 200 });
```

Both are enforced with `AbortSignal.timeout()`.

> **A note on `connectTimeout`.** `fetch` does not expose the TCP connect phase, so the SDK enforces
> this as a deadline for the server to *begin responding* — connect plus time-to-first-byte. The
> Python SDK, sitting on `httpx`, applies it to connect alone. If you see degraded results with
> `connect timeout` in the message and the API is healthy, raise it, or set `connectTimeout: 0` to
> disable it and let `timeout` govern alone. This is the only place where this SDK's behaviour
> differs from the Python one.

**Timed-out calls are never retried, and this is not configurable.** Every evaluation is a
server-side write, so a request that timed out may already have been recorded. Retrying it would
double-count your metered usage, duplicate your decision feed, and double the worst-case latency of
a call sitting in front of a user-visible action.

Opt-in retries (`retries: 2`) apply only to throttling and 5xx, with full-jitter backoff.

> **Server-side p99 is not published yet.** We are not going to print a number we have not measured
> under realistic load. If a hard latency budget matters to you, measure it against your own
> workload and [tell us what you see](https://safenode.tech). If you cannot afford the round trip at
> all, use [non-blocking mode](#non-blocking-mode).

---

## What data leaves your infrastructure

You are being asked to send descriptions of your agent's actions to a third party. Here is exactly
what that means.

**Everything sent is stored.** SafeNode persists the full envelope server-side for the audit trail
and decision feed. Assume anything you send is retained.

Three payload modes control what that is:

| `payloadMode` | What is sent |
| --- | --- |
| `"full"` | Payload values verbatim. |
| `"redacted"` **(default)** | Payload values scrubbed client-side first. |
| `"metadata_only"` | No payload values at all — key names and value hashes only. |

`context` is **always sent unredacted**, in every mode. This is load-bearing: vendor, region, and
spend gating are all driven by context, and scrubbing it would break them. Do not put secrets in
`context`.

### Inspect exactly what would be sent

`buildRequest()` is a dry run. No network call, no side effects:

```ts
sn.buildRequest("send_email", { to: "alice@corp.com", note: "card 4111111111111111" });
// {
//   action_type: "send_email",
//   payload: { to: "[REDACTED:email]", note: "card [REDACTED:credit_card]" },
//   context: {
//     safenode_payload_mode: "redacted",
//     safenode_redactions: { email: 1, credit_card: 1 },
//   },
// }
```

Default rules cover emails, credit cards (Luhn-validated, so order numbers survive), US SSNs,
provider API key prefixes (`sk-`, `ghp_`, `xoxb-`, `AKIA`, `AIza`), bearer tokens, PEM private key
blocks, and phone numbers.

```ts
import { Redactor, redactionRule, SafeNode } from "safenode-sdk";

const sn = new SafeNode(key, {
  redactor: new Redactor({
    extraRules: [redactionRule("employee_id", /\bEMP-\d{5}\b/g)],
    allowlistKeys: ["vendor_id"], // never redact these values
    redactKeys: ["internal_note"], // always strip these, whatever they contain
    disabledRules: ["phone"],
  }),
});
```

### Why redaction counts are sent

Notice `safenode_redactions` in the dry run above. The SDK reports *how many* values of each type it
stripped, and this is not optional.

SafeNode's server-side `sensitive_data` rule matches patterns against payload values. If the SDK
scrubbed those values and said nothing, a policy of "deny any action containing a card number" would
silently start passing — the client-side privacy feature would have disabled the server-side security
control. Reporting counts closes that hole: policy can act on the *presence* of a card number without
ever receiving one.

If you use `sensitive_data` with `patterns`, pair it with a `redaction_metadata` rule covering the
same types.

These counts are self-reported by the client. They raise the floor for honest callers; they are not a
defence against a hostile one, which could simply send an empty payload.

### `metadata_only`

For when payload values must not leave your network at all:

```ts
const sn = new SafeNode(key, { payloadMode: "metadata_only" });
```

Key names are preserved (so key-based rules keep working) and every value becomes a truncated
SHA-256. **Eight of SafeNode's nine rule types are context-driven and work identically in this
mode** — only pattern-based `sensitive_data` degrades, and the redaction counts partly cover it.

Hashes let you correlate identical values across requests, including against the Python SDK, which
hashes the same way. They are not a privacy guarantee for low-entropy values: anyone who guesses an
email address can confirm it. Pass `hashSalt: "..."` to prevent cross-tenant correlation.

### No telemetry

This package makes exactly one network call — to the SafeNode API, when you call `evaluate()`. No
analytics, no phone-home, no crash reporting, no `postinstall` script. **Zero runtime dependencies.**
For a security tool anything else would be disqualifying.

---

## Enforcement helpers

`evaluate()` returns a decision. These throw instead.

JavaScript has no `with` statement, so where Python's SDK offers a context manager, this one takes a
callback. `guard()` evaluates first, throws `PolicyDenied` if the action is blocked, and otherwise
runs your callback with the result and returns whatever it returns.

```ts
import { PolicyDenied } from "safenode-sdk";

// Callback form — the equivalent of Python's `with sn.guard(...) as decision:`
const traceId = await sn.guard(
  "delete_records",
  { payload: { table: "users", count: 400 } },
  async (decision) => {
    await deleteRecords();
    return decision.traceId;
  },
);

// Options are optional when you need none:
await sn.guard("call_model", async (decision) => run(decision));

// Wrapper form — the equivalent of Python's `@sn.guarded(...)` decorator.
// Arguments are only sent if you map them.
const sendEmail = sn.guarded(
  "send_email",
  async (to: string, body: string) => { /* ... */ },
  { payload: (to) => ({ to }) },
);
```

Both throw `PolicyDenied` on `deny` and `review`. `warn` proceeds by default; pass
`allowWarn: false` to treat warnings as blocking.

Branch on the boolean getters rather than comparing strings:

```ts
result.allowed; // allow
result.warned; // warn
result.needsReview; // review
result.denied; // deny
result.permitted; // allow or warn  — "may proceed"
result.blocked; // review or deny — "must not proceed"
```

`permitted` exists because `if (result.allowed)` silently blocks every `warn`, which is rarely what
people mean the first time.

---

## Non-blocking mode

For audit-and-alert when you cannot afford to await a round trip in a hot path:

```ts
void sn.evaluateNoWait("call_model", { prompt });
```

**This cannot gate anything** — you get no decision back. It records the action and lets policy
violations surface in your dashboard and alerts after the fact. Errors are swallowed and logged: a
SafeNode failure must never surface in your application as an unhandled rejection.

---

## Error handling

```ts
import {
  SafeNodeError, // base — catching this contains the SDK entirely
  ConfigurationError, // bad options, thrown at construction
  AuthError, // 401 — bad, expired, or unbound key
  ValidationError, // 422 — server rejected the request
  PayloadTooLargeError, // 422 — payload or context over 256 KiB
  RateLimitError, // 429 — throttled. RETRYABLE after .retryAfter
  QuotaExceededError, // 429 — monthly cap exhausted. NOT retryable
  Unavailable, // unreachable (only thrown when onUnavailable: "raise")
  PolicyDenied, // thrown by guard()/guarded(), never by evaluate()
} from "safenode-sdk";
```

**The one that will bite you:** SafeNode returns HTTP 429 for two unrelated conditions. Throttling is
transient and retryable. Monthly quota exhaustion is not — it stays failing until your next billing
month, and retrying with backoff will just fail for days. The SDK discriminates on the response body
and throws different types, so you do not have to:

```ts
try {
  const result = await sn.evaluate("send_email", payload);
} catch (error) {
  if (error instanceof QuotaExceededError) {
    alert(`SafeNode quota exhausted: ${error.evaluationsUsed}/${error.evaluationsCap}`);
  } else if (error instanceof RateLimitError) {
    backoff(error.retryAfter);
  } else {
    throw error;
  }
}
```

`evaluate()` never throws on a `deny` — a denial is a successful evaluation. Use `guard()` if you
want the exception.

---

## Why not just write if-statements

For one rule in one codebase, honestly, write the if-statement. This earns its place when:

- **The rules change more often than the code.** Policy lives in a dashboard; a non-engineer can
  tighten a spend limit without a deploy.
- **You need the audit trail.** Every decision is recorded with a `traceId`, the inputs, and the
  matched rules. Reconstructing "why did the agent do that on the 14th" from application logs is
  work you will do exactly once before wishing you had this.
- **Enforcement has to be consistent across agents.** Five agents in three languages plus some n8n
  workflows will not stay consistent by convention.
- **`review` is a real state.** Human-in-the-loop approval queues are a meaningful amount of code to
  build, and an if-statement cannot return "ask someone".

If none of those apply, use the if-statement. It is faster and has no failure mode.

---

## Why not OPA

Open Policy Agent is a good tool and solves an overlapping problem. Genuine differences:

- **Rego is a language.** Someone on your team has to learn and maintain it. SafeNode's rules are
  configured in a UI, which is a real limitation as well as a real advantage.
- **Scoring vs. boolean.** OPA answers yes/no. SafeNode returns weighted impact and risk scores
  banded into four outcomes, including `review`. If you want a human approval step for medium-risk
  actions, that is native here and something you would build yourself on OPA.
- **Batteries for this specific domain.** Vendor registries, spend thresholds, region gating, and
  business-hours rules ship working. On OPA they are Rego you write.
- **OPA runs locally.** That is a genuine OPA advantage: no network call and no third party. If
  sub-millisecond local evaluation is a hard requirement, use OPA.

They compose. OPA for infrastructure authz, SafeNode for agent actions, is a reasonable architecture.

---

## FAQ

**Does it run in the browser?**
The core path is browser-safe: global `fetch`, no `node:` imports, no dependencies. But putting a
SafeNode API key in client-side code hands it to your users. Call it from your server.

**Is there a CommonJS build?**
Yes. `require("safenode-sdk")` and `import` both work, with type declarations for each.

**Is there a self-hosted or VPC deployment?**
Not yet. It is planned, with no committed date. Today SafeNode is hosted only. If this is a blocker,
[say so](https://safenode.tech) — it moves the roadmap.

**What is the API stability commitment?**
`/api/v1` is additive-only. New response fields may appear; existing fields will not change type or
disappear without a new version path. Unknown fields are preserved on `result.raw`, so a server-side
addition cannot break your build. The SDK follows semver and is pre-1.0 — minor versions may change
the TypeScript surface until 1.0.0.

**What are the rate limits?**
60 requests/minute per API key by default. Separately, each plan has a monthly evaluation cap; see
`QuotaExceededError` above.

**Does `actionType` have to come from a fixed list?**
No, it is free-form (max 255 characters) and typed as `string`. Rules match on exact strings, so pick
stable names and keep them consistent. `send_email`, `call_model`, `mcp_tool_call`,
`run_shell_command` are conventions, not requirements.

**Do I need to send `agentId`?**
No. The API key already identifies the agent.

**Does this work with LangChain / Mastra / n8n?**
Not yet as a first-party adapter. `guarded()` wraps a tool function in three lines meanwhile. Tell us
which one you need.

---

## API reference

### `new SafeNode(apiKey, options?)`

| Option | Default | Notes |
| --- | --- | --- |
| `apiKey` | required | Your `sn_...` key (first positional argument) |
| `baseUrl` | `https://safenode.tech` | For staging |
| `onUnavailable` | `"fail_open"` | `fail_open` \| `fail_closed` \| `raise` |
| `timeout` | `2000` | Total milliseconds |
| `connectTimeout` | `500` | Milliseconds; `0` disables |
| `payloadMode` | `"redacted"` | `full` \| `redacted` \| `metadata_only` |
| `redactor` | `new Redactor()` | Custom rules |
| `retries` | `0` | 429/5xx only, never timeouts |
| `staticContext` | `{}` | Merged into every request |
| `agentId` | `null` | Usually unnecessary |
| `hashSalt` | `""` | For `metadata_only` |
| `fetch` | global `fetch` | Inject for proxies, mTLS, or tests |
| `logger` | `console` | Anything with `warn(message)` |

### `evaluate(actionType, payload?, context?, options?): Promise<Result>`

`options` takes `payloadMode`, `correlationId`, `agentId`, and `signal`. `correlationId` is passed
through in `context.correlation_id` so you can join SafeNode decisions to your own logs.

### `buildRequest(actionType, payload?, context?, options?): EvaluateRequestBody`

The dry run. Same arguments as `evaluate()`, no network call.

### `guard(actionType, options?, fn): Promise<T>` and `guarded(actionType, fn, options?)`

See [Enforcement helpers](#enforcement-helpers).

### `Result`

`decision`, `impactScore`, `riskScore` (both **0–100**), `matchedPolicies`, `reasons`,
`alternatives`, `traceId`, `degraded`, `raw`, plus the boolean getters above.

Two server-side details worth knowing: `alternatives` is never empty — a `general` suggestion is
always appended, including on `allow` — and `matchedPolicies` is empty on hard-rule denials, so use
`reasons` for attribution.

### Differences from the Python SDK

Deliberate, and the complete list:

- **One client, not two.** JavaScript has no blocking I/O, so `SafeNode` is the async client and
  there is no `AsyncSafeNode`.
- **`guard()` takes a callback**, because JavaScript has no `with` statement. `guarded()` is a
  wrapper function rather than a decorator.
- **`connectTimeout` covers connect plus time-to-first-byte**, because `fetch` does not expose the
  connect phase. See the [latency note](#latency).
- **Timeouts are in milliseconds**, not seconds — the platform convention.
- **No OpenTelemetry integration**, which would mean a dependency. Wrap `evaluate()` in your own
  span; `result.traceId` and `result.degraded` are the two attributes worth recording.
- **No background queue.** `evaluateNoWait()` simply does not await, which is what a bounded worker
  thread was emulating in Python.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports welcome, especially about the contract — if the
SDK and the API disagree, that is a bug worth filing. So is any behavioural divergence from the
Python SDK that is not listed above.

## Security

See [SECURITY.md](SECURITY.md). Please do not open public issues for vulnerabilities.

## License

MIT. See [LICENSE](LICENSE).
