/**
 * Exactly what leaves your process, across all three payload modes.
 *
 * Makes no network calls and needs no API key. Start here — it answers the question most people
 * have first: what am I actually sending to a third party?
 *
 *   node examples/03-redaction-dry-run.mjs
 */

import { Redactor, SafeNode, redactionRule } from "../dist/index.js";

const KEY = "sn_dry_run_key_0000000000";

const payload = {
  to: "alice@corp.com",
  cc: ["bob@corp.com", "ops@corp.com"],
  subject: "Refund for order 1234567890123456", // 16 digits, but fails Luhn — survives
  body: "Card 4111111111111111, SSN 123-45-6789, call 555-867-5309.",
  api_key: "sk-abcdefghijklmnopqrstuvwx",
  vendor_id: "sk-lookalike-but-safe-0000",
  internal_note: "nothing sensitive, but we never send it",
};

const context = { vendor_id: "sendgrid", cost_estimate: 0.01, region: "us-east-1" };

function show(label, body) {
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(body, null, 2));
}

for (const payloadMode of ["full", "redacted", "metadata_only"]) {
  const sn = new SafeNode(KEY, { payloadMode });
  show(payloadMode, sn.buildRequest("send_email", payload, context));
}

// Note in every output above:
//   * context is never redacted, in any mode — vendor/region/spend gating depends on it.
//     Do not put secrets in context.
//   * safenode_redactions is always present. Without those counts, client-side redaction would
//     silently disable the server's sensitive_data rule.
//   * metadata_only keeps the key NAMES and hashes only the values, because policy can match on
//     key names.

// Custom rules, an allowlisted key, and a force-redacted key:
const custom = new SafeNode(KEY, {
  redactor: new Redactor({
    extraRules: [redactionRule("employee_id", /\bEMP-\d{5}\b/g)],
    allowlistKeys: ["vendor_id"], // looks like a token, is not one — policy needs it intact
    redactKeys: ["internal_note"], // always stripped, whatever it contains
    disabledRules: ["phone"],
  }),
});

show(
  "custom redactor",
  custom.buildRequest("send_email", { ...payload, who: "EMP-12345" }, context),
);

// The dry run is exactly the body evaluate() would POST. Nothing is added downstream.
