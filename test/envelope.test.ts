import { describe, expect, it } from "vitest";

import { buildEnvelope, Redactor, SafeNode } from "../src/index.js";
import { pythonRepr } from "../src/envelope.js";
import { sha256Hex } from "../src/sha256.js";
import { API_KEY, mockFetch } from "./helpers.js";

const explodingFetch = () => {
  throw new Error("dry run must not touch the network");
};

describe("payload modes", () => {
  it("full mode sends values verbatim", () => {
    const { body, counts } = buildEnvelope({
      actionType: "send_email",
      payload: { to: "a@b.com" },
      payloadMode: "full",
    });
    expect(body.payload).toEqual({ to: "a@b.com" });
    expect(counts).toEqual({});
  });

  it("redacted mode scrubs values", () => {
    const { body, counts } = buildEnvelope({
      actionType: "send_email",
      payload: { to: "a@b.com" },
      payloadMode: "redacted",
    });
    expect(body.payload).toEqual({ to: "[REDACTED:email]" });
    expect(counts).toEqual({ email: 1 });
  });

  it("metadata_only sends no values", () => {
    const { body } = buildEnvelope({
      actionType: "send_email",
      payload: { to: "alice@example.com", subject: "Secret" },
      payloadMode: "metadata_only",
    });
    const serialized = JSON.stringify(body.payload);
    expect(serialized).not.toContain("alice@example.com");
    expect(serialized).not.toContain("Secret");
    const values = Object.values(body.payload as Record<string, string>);
    expect(values.every((v) => v.startsWith("sha256:"))).toBe(true);
    expect(values.every((v) => v.length === "sha256:".length + 16)).toBe(true);
  });

  it("metadata_only preserves key names", () => {
    // The sensitive_data rule matches on key names; flattening would disable it.
    const { body } = buildEnvelope({
      actionType: "x",
      payload: { ssn: "123-45-6789", nested: { card: "4111111111111111" } },
      payloadMode: "metadata_only",
    });
    const payload = body.payload as Record<string, Record<string, unknown>>;
    expect(Object.keys(payload).sort()).toEqual(["nested", "ssn"]);
    expect(Object.keys(payload["nested"] as object)).toEqual(["card"]);
  });

  it("metadata_only still reports redaction counts", () => {
    // Policy keeps the same signal it would get in redacted mode.
    const { body, counts } = buildEnvelope({
      actionType: "x",
      payload: { to: "a@b.com" },
      payloadMode: "metadata_only",
    });
    expect(counts).toEqual({ email: 1 });
    expect(body.context["safenode_redactions"]).toEqual({ email: 1 });
  });

  it("hashes arrays element-wise while keeping the shape", () => {
    const { body } = buildEnvelope({
      actionType: "x",
      payload: { xs: ["a@b.com", 1] },
      payloadMode: "metadata_only",
    });
    const xs = (body.payload as { xs: string[] }).xs;
    expect(xs).toHaveLength(2);
    expect(xs.every((v) => v.startsWith("sha256:"))).toBe(true);
  });

  it("produces stable hashes for equal values", () => {
    const a = buildEnvelope({ actionType: "x", payload: { v: "same" }, payloadMode: "metadata_only" });
    const b = buildEnvelope({ actionType: "x", payload: { v: "same" }, payloadMode: "metadata_only" });
    expect(a.body.payload).toEqual(b.body.payload);
  });

  it("changes the digest when a hashSalt is set", () => {
    const a = buildEnvelope({
      actionType: "x",
      payload: { v: "same" },
      payloadMode: "metadata_only",
      hashSalt: "one",
    });
    const b = buildEnvelope({
      actionType: "x",
      payload: { v: "same" },
      payloadMode: "metadata_only",
      hashSalt: "two",
    });
    expect(a.body.payload).not.toEqual(b.body.payload);
  });

  it("rejects an unknown mode", () => {
    expect(() =>
      buildEnvelope({ actionType: "x", payloadMode: "nonsense" as never }),
    ).toThrow(/payloadMode/);
  });
});

describe("hashing primitives", () => {
  it("computes SHA-256 correctly", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex("a".repeat(1000)).length).toBe(64);
  });

  it("produces the same digests as the Python SDK", () => {
    // Golden values from the Python SDK's `_hash_value`:
    //   "sha256:" + sha256((salt + repr(value)).encode()).hexdigest()[:16]
    // Generated with CPython; if these drift, metadata_only stops correlating across SDKs.
    const { body } = buildEnvelope({
      actionType: "x",
      payload: { a: "same", b: "it's", c: 42, d: true, e: null, f: "alice@corp.com" },
      payloadMode: "metadata_only",
    });
    expect(body.payload).toEqual({
      a: "sha256:d816432418ca649b",
      b: "sha256:e8a14e7df117da81",
      c: "sha256:73475cb40a568e8d",
      d: "sha256:3cbc87c7681f34db",
      e: "sha256:dc937b59892604f5",
      f: "sha256:ed3c791ee5a02d9d",
    });
  });

  it("mirrors Python repr for the leaf types a JSON payload can hold", () => {
    // Keeps metadata_only digests identical across the Python and JS SDKs.
    expect(pythonRepr("same")).toBe("'same'");
    expect(pythonRepr(42)).toBe("42");
    expect(pythonRepr(true)).toBe("True");
    expect(pythonRepr(false)).toBe("False");
    expect(pythonRepr(null)).toBe("None");
    expect(pythonRepr("it's")).toBe('"it\'s"');
  });
});

describe("context handling", () => {
  it("always reports redaction metadata, even in full mode", () => {
    const { body } = buildEnvelope({ actionType: "x", payload: { a: 1 }, payloadMode: "full" });
    expect(body.context["safenode_payload_mode"]).toBe("full");
    expect(body.context["safenode_redactions"]).toEqual({});
  });

  it("never redacts context", () => {
    // Redacting context would break vendor, region and spend gating outright.
    const { body } = buildEnvelope({
      actionType: "x",
      context: { vendor_id: "sk-abcdefghijklmnopqrstuvwx" },
      payloadMode: "redacted",
    });
    expect(body.context["vendor_id"]).toBe("sk-abcdefghijklmnopqrstuvwx");
  });

  it("merges staticContext and lets per-call context win", () => {
    const { body } = buildEnvelope({
      actionType: "x",
      context: { region: "us-east-1" },
      staticContext: { region: "eu-west-1", env: "prod" },
    });
    expect(body.context["region"]).toBe("us-east-1");
    expect(body.context["env"]).toBe("prod");
  });

  it("passes correlationId through", () => {
    const { body } = buildEnvelope({ actionType: "x", correlationId: "req-42" });
    expect(body.context["correlation_id"]).toBe("req-42");
  });

  it("omits agent_id when not set", () => {
    expect(buildEnvelope({ actionType: "x" }).body.agent_id).toBeUndefined();
  });

  it("never sends an org selector", () => {
    // The server ignores these and the enforcing org always comes from the API key.
    const { body } = buildEnvelope({ actionType: "x", context: { org_id: "tenant-7" } });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("organization_id");
    expect(serialized).not.toContain("safenode_organization_id");
    // context.org_id is the caller's own tenant id and is legitimate.
    expect(body.context["org_id"]).toBe("tenant-7");
  });
});

describe("buildRequest (dry run)", () => {
  it("makes no network call", () => {
    const sn = new SafeNode(API_KEY, { fetch: explodingFetch as never });
    expect(sn.buildRequest("send_email", { to: "a@b.com" }).payload).toEqual({
      to: "[REDACTED:email]",
    });
  });

  it("lets a per-call mode override the client default", () => {
    const sn = new SafeNode(API_KEY, { payloadMode: "redacted", fetch: explodingFetch as never });
    const body = sn.buildRequest("x", { to: "a@b.com" }, null, { payloadMode: "full" });
    expect(body.payload).toEqual({ to: "a@b.com" });
  });

  it("uses a custom redactor", () => {
    const sn = new SafeNode(API_KEY, {
      redactor: new Redactor({ disabledRules: ["email"] }),
      fetch: explodingFetch as never,
    });
    expect(sn.buildRequest("x", { to: "a@b.com" }).payload).toEqual({ to: "a@b.com" });
  });

  it("returns exactly the body that evaluate() sends", async () => {
    const { fetch, recorder } = mockFetch();
    const sn = new SafeNode(API_KEY, { fetch, staticContext: { env: "prod" } });
    const dry = sn.buildRequest("send_email", { to: "a@b.com" }, { vendor_id: "sendgrid" });
    await sn.evaluate("send_email", { to: "a@b.com" }, { vendor_id: "sendgrid" });
    expect(recorder.lastBody).toEqual(dry);
  });
});
