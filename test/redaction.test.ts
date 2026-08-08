import { describe, expect, it } from "vitest";

import { DEFAULT_RULES, Redactor, redactionRule } from "../src/index.js";
import { luhnOk } from "../src/redaction.js";

const redactor = new Redactor();

describe("default rules", () => {
  it("redacts an email", () => {
    const report = redactor.redact({ to: "alice@example.com" });
    expect(report.data).toEqual({ to: "[REDACTED:email]" });
    expect(report.counts).toEqual({ email: 1 });
  });

  it("redacts a Luhn-valid credit card", () => {
    // 4111 1111 1111 1111 is the canonical Luhn-valid Visa test number.
    const report = redactor.redact({ card: "4111111111111111" });
    expect(report.data).toEqual({ card: "[REDACTED:credit_card]" });
    expect(report.counts).toEqual({ credit_card: 1 });
  });

  it("redacts a credit card written with separators", () => {
    const report = redactor.redact({ card: "4111-1111-1111-1111" });
    expect(report.data.card).toContain("[REDACTED:credit_card]");
  });

  it("leaves a Luhn-invalid number alone", () => {
    // A 16-digit order number that fails Luhn must survive, or we corrupt real payloads.
    const report = redactor.redact({ order: "1234567890123456" });
    expect(report.data).toEqual({ order: "1234567890123456" });
    expect(report.counts).toEqual({});
  });

  it("validates Luhn length bounds", () => {
    expect(luhnOk("4111111111111111")).toBe(true);
    expect(luhnOk("1234567890123456")).toBe(false);
    expect(luhnOk("411111111111")).toBe(false); // 12 digits: below the 13 minimum
  });

  it("redacts a US SSN", () => {
    expect(redactor.redact({ ssn: "123-45-6789" }).data).toEqual({ ssn: "[REDACTED:us_ssn]" });
  });

  it.each([
    "sk-abcdefghijklmnopqrstuvwx",
    `ghp_${"a".repeat(36)}`,
    `gho_${"a".repeat(36)}`,
    `ghs_${"a".repeat(36)}`,
    `github_pat_${"a".repeat(24)}`,
    "xoxb-123456789012-abcdefg",
    "AKIAIOSFODNN7EXAMPLE",
    `AIza${"b".repeat(35)}`,
    "sn_abcdefghijklmnop123",
  ])("redacts the API key %s", (secret) => {
    expect(redactor.redact({ k: secret }).data).toEqual({ k: "[REDACTED:api_key]" });
  });

  it("redacts a bearer token", () => {
    expect(redactor.redact({ h: "Bearer abcdefghijklmnop" }).data).toEqual({
      h: "[REDACTED:bearer_token]",
    });
  });

  it("redacts a PEM private key block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";
    expect(redactor.redact({ key: pem }).data).toEqual({ key: "[REDACTED:private_key]" });
  });

  it("redacts a phone number", () => {
    expect(redactor.redact({ p: "555-867-5309" }).data).toEqual({ p: "[REDACTED:phone]" });
  });

  it("leaves a clean payload untouched", () => {
    const original = { model: "gpt-4", tokens: 500, ok: true };
    const report = redactor.redact(original);
    expect(report.data).toEqual(original);
    expect(report.counts).toEqual({});
    expect(report.redactedAnything).toBe(false);
  });

  it("ships the documented rules in the documented order", () => {
    expect(DEFAULT_RULES.map((r) => r.name)).toEqual([
      "private_key",
      "api_key",
      "bearer_token",
      "email",
      "credit_card",
      "us_ssn",
      "phone",
    ]);
  });
});

describe("traversal", () => {
  it("walks nested structures", () => {
    const report = redactor.redact({
      user: { contacts: [{ email: "a@b.com" }, { email: "c@d.com" }] },
    });
    expect(report.counts).toEqual({ email: 2 });
    expect(report.data.user.contacts[0]?.email).toBe("[REDACTED:email]");
  });

  it("counts multiple matches in one string", () => {
    expect(redactor.redact({ body: "mail a@b.com or c@d.com" }).counts).toEqual({ email: 2 });
  });

  it("never redacts keys", () => {
    // SafeNode's sensitive_data rule matches on key names; destroying them breaks it.
    const report = redactor.redact({ "user@example.com": "value" });
    expect(Object.keys(report.data)).toEqual(["user@example.com"]);
  });

  it("does not mutate the input", () => {
    const original = { to: "a@b.com", nested: { x: "c@d.com" } };
    redactor.redact(original);
    expect(original).toEqual({ to: "a@b.com", nested: { x: "c@d.com" } });
  });

  it("passes non-string scalars through", () => {
    const report = redactor.redact({ n: 42, f: 1.5, b: false, none: null });
    expect(report.data).toEqual({ n: 42, f: 1.5, b: false, none: null });
  });

  it("does not recurse without bound on deeply nested input", () => {
    let node: Record<string, unknown> = { leaf: "a@b.com" };
    for (let i = 0; i < 200; i += 1) node = { child: node };
    expect(() => redactor.redact(node)).not.toThrow();
  });

  it("terminates on a self-referencing structure", () => {
    const node: Record<string, unknown> = {};
    node["self"] = node;
    expect(() => redactor.redact(node)).not.toThrow();
  });
});

describe("configuration", () => {
  it("preserves allowlisted keys", () => {
    const r = new Redactor({ allowlistKeys: ["vendor_id"] });
    const report = r.redact({ vendor_id: "sk-abcdefghijklmnopqrstuvwx", other: "a@b.com" });
    expect(report.data.vendor_id).toBe("sk-abcdefghijklmnopqrstuvwx");
    expect(report.data.other).toBe("[REDACTED:email]");
  });

  it("matches allowlist keys case-insensitively", () => {
    const r = new Redactor({ allowlistKeys: ["Vendor_ID"] });
    expect(r.redact({ vendor_id: "a@b.com" }).data.vendor_id).toBe("a@b.com");
  });

  it("honours disabledRules", () => {
    const r = new Redactor({ disabledRules: ["email"] });
    expect(r.redact({ to: "a@b.com" }).data).toEqual({ to: "a@b.com" });
  });

  it("honours extraRules", () => {
    const r = new Redactor({ extraRules: [redactionRule("employee_id", /\bEMP-\d{5}\b/g)] });
    const report = r.redact({ who: "EMP-12345" });
    expect(report.data).toEqual({ who: "[REDACTED:employee_id]" });
    expect(report.counts).toEqual({ employee_id: 1 });
  });

  it("strips redactKeys regardless of content", () => {
    const r = new Redactor({ redactKeys: ["internal_note"] });
    const report = r.redact({ internal_note: "nothing sensitive here" });
    expect(report.data).toEqual({ internal_note: "[REDACTED:key]" });
    expect(report.counts).toEqual({ key: 1 });
  });

  it("replaces the defaults when a custom ruleset is given", () => {
    const r = new Redactor({ rules: [redactionRule("x", /XXX/g)] });
    const report = r.redact({ to: "a@b.com", x: "XXX" });
    expect(report.data.to).toBe("a@b.com");
    expect(report.data.x).toBe("[REDACTED:x]");
  });

  it("adds the global flag to a non-global custom pattern", () => {
    const r = new Redactor({ rules: [redactionRule("x", /XXX/)] });
    expect(r.redact({ x: "XXX XXX" }).counts).toEqual({ x: 2 });
  });

  it("redacts a bare string with redactText", () => {
    expect(redactor.redactText("write to a@b.com").data).toBe("write to [REDACTED:email]");
  });
});
