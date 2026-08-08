/**
 * Gate one action, and handle all four decisions plus `degraded`.
 *
 *   SAFENODE_API_KEY=sn_... node examples/01-basic-gate.mjs
 */

import { SafeNode, SafeNodeError } from "../dist/index.js";

const apiKey = process.env.SAFENODE_API_KEY;
if (!apiKey) {
  console.error("Set SAFENODE_API_KEY. Free key at https://safenode.tech");
  process.exit(1);
}

// fail_closed: an unevaluated outbound email is worse than a failed one.
const sn = new SafeNode(apiKey, { onUnavailable: "fail_closed" });

try {
  const result = await sn.evaluate(
    "send_email",
    { to: "customer@example.com", subject: "Your refund", body: "Processed." },
    { vendor_id: "sendgrid", cost_estimate: 0.01, region: "us-east-1" },
  );

  // Always check this first. A degraded result is not a policy decision — SafeNode never saw the
  // action, and counting it as an allow would overstate your coverage.
  if (result.degraded) {
    console.warn("SafeNode was unreachable; this is a synthetic decision, not a policy one.");
  }

  console.log(`decision: ${result.decision}`);
  console.log(`impact ${result.impactScore} / risk ${result.riskScore} (0-100)`);
  console.log(`trace:   ${result.traceId ?? "(none — degraded)"}`);

  if (result.allowed) {
    console.log("Sending.");
  } else if (result.warned) {
    // `permitted` is allow-or-warn. `allowed` alone silently blocks every warn.
    console.log(`Sending with a warning: ${result.reasons.join("; ")}`);
  } else if (result.needsReview) {
    console.log(`Queued for human approval: ${result.reasons.join("; ")}`);
  } else if (result.denied) {
    console.log(`Blocked: ${result.reasons.join("; ")}`);
  }

  // The server never returns an empty alternatives list — a `general` suggestion is always
  // appended, including on allow. A non-empty list is not evidence that something was wrong.
  for (const alt of result.alternatives) {
    console.log(`  alternative [${alt.type}] ${alt.description}`);
  }
} catch (error) {
  if (error instanceof SafeNodeError) {
    console.error(`SafeNode error (${error.name}): ${error.message}`);
    process.exit(1);
  }
  throw error;
}
