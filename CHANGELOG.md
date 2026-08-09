# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the version is below 1.0.0, minor releases may change the TypeScript surface. The underlying
`/api/v1` HTTP contract is additive-only.

## [Unreleased]

## [0.1.1] - 2026-08-09

No functional change to the SDK. Released to verify that publishing works over OIDC trusted
publishing rather than a long-lived npm token.

### Changed

- Publishes via OIDC trusted publishing. No npm token exists to leak or rotate.
- The publish job runs Node 24 and pins `npm@latest`. Node 22 ships npm 10.9.x, which predates OIDC
  support (needs >= 11.5.1); without this the publish fails with an auth error that mentions
  nothing about versions.

## [0.1.0] - 2026-08-08

First release. A port of the SafeNode Python SDK 0.1.0, mirroring its options (in camelCase),
result fields, fail modes, redaction rules, and error taxonomy.

### Added

- `SafeNode` client with `evaluate()` returning a `Result` carrying `decision`, `impactScore`,
  `riskScore`, `matchedPolicies`, `reasons`, `alternatives`, `traceId`, `degraded`, and `raw`, plus
  `allowed` / `warned` / `needsReview` / `denied` / `permitted` / `blocked` getters.
- `guard()` callback helper and `guarded()` function wrapper, throwing `PolicyDenied` on `deny` and
  `review`. Wrapped functions send nothing about their arguments unless given an explicit mapper.
- Three fail modes via `onUnavailable`: `fail_open` (default), `fail_closed`, `raise`. Degraded
  results are marked in three independent ways — `degraded: true`, `traceId: null`, and
  `reasons: ["safenode_unavailable"]` — so they can never be miscounted as policy decisions.
- Client-side `Redactor` covering emails, Luhn-validated credit cards, US SSNs, provider API key
  prefixes (`sk-`, `ghp_`, `xoxb-`, `AKIA`, `AIza`), bearer tokens, PEM private key blocks, and
  phone numbers. Extensible with custom rules, key allowlists, and forced-redaction keys.
- Redaction counts reported to policy in `context.safenode_redactions`, so client-side redaction
  cannot silently disable the server-side `sensitive_data` rule.
- Three payload modes: `full`, `redacted` (default), and `metadata_only`. `metadata_only` preserves
  key names — key-based policy rules keep working — and hashes every value with a bundled
  synchronous SHA-256, digest-compatible with the Python SDK.
- `buildRequest()` dry run: returns the exact body that would be sent, with no network call.
- Non-blocking `evaluateNoWait()` for audit-and-alert.
- Distinct `RateLimitError` (retryable) and `QuotaExceededError` (not retryable) for the two
  unrelated conditions the API returns as HTTP 429.
- `correlationId` pass-through, injectable `fetch` and `logger`, and caller-supplied `AbortSignal`.
- ESM and CommonJS builds with type declarations for both.

### Notes

- Published as `safenode-sdk` (unscoped). The `@safenode` npm scope belongs to an unrelated project.
- **Zero runtime dependencies.** Global `fetch`, Node 18+, browser-safe core path.
- No telemetry, no phone-home, no analytics, no `postinstall` script.
- Deliberate divergences from the Python SDK are listed in the README under
  "Differences from the Python SDK".

[Unreleased]: https://github.com/sp3ak/safenode-js/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/sp3ak/safenode-js/releases/tag/v0.1.1
[0.1.0]: https://github.com/sp3ak/safenode-js/releases/tag/v0.1.0
