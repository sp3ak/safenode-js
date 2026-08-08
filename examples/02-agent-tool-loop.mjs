/**
 * One choke point in front of every tool call, with split fail modes.
 *
 * The pattern that matters: your agent does not call tools, it calls `callTool`, and `callTool`
 * asks SafeNode first. One place to change, one place to audit.
 *
 *   SAFENODE_API_KEY=sn_... node examples/02-agent-tool-loop.mjs
 */

import { PolicyDenied, QuotaExceededError, RateLimitError, SafeNode } from "../dist/index.js";

const apiKey = process.env.SAFENODE_API_KEY;
if (!apiKey) {
  console.error("Set SAFENODE_API_KEY. Free key at https://safenode.tech");
  process.exit(1);
}

// Two clients, because the right fail mode depends on what the action does.
// Reads: keep working if SafeNode is down. Writes: stop.
const audit = new SafeNode(apiKey, {
  onUnavailable: "fail_open",
  staticContext: { env: "prod", agent: "support-bot" },
});
const gate = new SafeNode(apiKey, {
  onUnavailable: "fail_closed",
  staticContext: { env: "prod", agent: "support-bot" },
});

const SIDE_EFFECTING = new Set(["send_email", "issue_refund", "delete_records"]);

const TOOLS = {
  search_docs: async ({ query }) => `3 results for ${query}`,
  send_email: async ({ to }) => `email queued for ${to}`,
  issue_refund: async ({ amount }) => `refunded $${amount}`,
};

async function callTool(name, args, { correlationId }) {
  const sn = SIDE_EFFECTING.has(name) ? gate : audit;

  // guard() is the callback equivalent of Python's `with sn.guard(...) as decision:`.
  // It throws PolicyDenied on deny and review; warn proceeds unless allowWarn: false.
  return await sn.guard(
    name,
    { payload: args, context: { tool: name }, correlationId },
    async (decision) => {
      if (decision.degraded) {
        console.warn(`  [${name}] running unevaluated — SafeNode was unreachable`);
      }
      if (decision.warned) {
        console.warn(`  [${name}] warned: ${decision.reasons.join("; ")}`);
      }
      const output = await TOOLS[name](args);
      console.log(`  [${name}] ok (trace ${decision.traceId ?? "none"})`);
      return output;
    },
  );
}

const plan = [
  ["search_docs", { query: "refund policy" }],
  ["send_email", { to: "customer@example.com", subject: "Your refund" }],
  ["issue_refund", { amount: 4200, currency: "USD" }],
];

const correlationId = `run-${Date.now()}`;

for (const [name, args] of plan) {
  console.log(`step: ${name}`);
  try {
    const output = await callTool(name, args, { correlationId });
    console.log(`  -> ${output}`);
  } catch (error) {
    if (error instanceof PolicyDenied) {
      // A denial is the system working. Feed the reasons back to the model rather than crashing.
      console.log(`  -> refused: ${error.reasons.join("; ")} (trace ${error.traceId})`);
      continue;
    }
    if (error instanceof QuotaExceededError) {
      // Not retryable — the monthly cap does not reset until the next billing month.
      console.error(`  -> quota exhausted: ${error.evaluationsUsed}/${error.evaluationsCap}`);
      break;
    }
    if (error instanceof RateLimitError) {
      console.error(`  -> throttled; retry after ${error.retryAfter}s`);
      break;
    }
    throw error;
  }
}
