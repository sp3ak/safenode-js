# Security Policy

## Reporting a vulnerability

Email **security@safenode.tech**. Please do not open a public issue.

Include what you can: affected version, reproduction steps, and impact. If you have a `traceId`
from an affected request, include it.

You will get an acknowledgement within 3 business days and an assessment within 10. If a fix is
warranted we will coordinate disclosure timing with you, and credit you unless you prefer otherwise.

## Supported versions

Pre-1.0, only the latest minor version receives fixes. Upgrade before reporting if you can.

## Scope

In scope for this repository:

- Sensitive data leaving the process when a redaction or payload mode should have prevented it
- Credential handling in the client
- Anything that causes a `deny` to be reported as an `allow`, or a degraded result to be
  indistinguishable from a real decision
- Supply-chain concerns in the published package (this package has zero runtime dependencies and no
  install scripts; anything suggesting otherwise is worth reporting)

Server-side issues in the SafeNode API belong at the same address, but note them as such.

## Known limitations (not vulnerabilities)

These are documented design boundaries. Reports about them are welcome as discussion, but they are
not treated as vulnerabilities:

- **Redaction counts are self-reported.** A hostile client can under-report or simply send an empty
  payload. Client-side redaction raises the floor for honest callers; it is not a trust boundary.
- **`metadata_only` hashes are not a privacy guarantee for low-entropy values.** A SHA-256 of an
  email address can be confirmed by anyone who guesses the address. Use `hashSalt` to prevent
  cross-tenant correlation.
- **`fail_open` is the default.** When SafeNode is unreachable, actions are allowed and the result
  is marked `degraded: true`. This is a documented, deliberate tradeoff — set
  `onUnavailable: "fail_closed"` where it does not suit you.
- **`context` is never redacted**, in any payload mode. Vendor, region, and spend gating all depend
  on it. Do not put secrets in `context`.
- **The full envelope is stored server-side.** Assume anything sent is retained.
- **Running this in a browser exposes your API key.** The core path is browser-safe, but that is
  about portability, not about it being a good idea. Call SafeNode from your server.
