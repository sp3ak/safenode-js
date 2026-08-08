# Contributing

Thanks for looking. This is maintained by one person, so a few notes on what helps.

## Most useful contribution

**Contract bugs.** If the SDK and the SafeNode API disagree — a field that is not the type we
claim, an error shape we mishandle, a status code we map wrong — that is the highest-value issue you
can file. Include the `traceId` if you have one.

**Divergence from the Python SDK** is a close second. The two SDKs are meant to behave identically;
anything that differs and is not listed in the README's "Differences from the Python SDK" section is
a bug.

## Setup

```bash
npm install
npm test
```

## Before opening a PR

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

All four must pass. CI runs the same on Node 18, 20, and 22.

## House rules

- **Zero runtime dependencies, permanently.** The `dependencies` block stays empty. If you need
  something from Node's standard library, it must not be on the path a browser executes.
- **No telemetry, ever.** No analytics, no phone-home, no `postinstall` script. Non-negotiable for a
  security tool.
- **Keep parity with the Python SDK.** Same option names in camelCase, same result fields, same fail
  modes, same redaction rule names and order, same error taxonomy, same defaults. A deliberate
  divergence needs a reason in the PR and a line in the README.
- **Every fail path needs a test.** Timeouts, 5xx, both flavours of 422, both flavours of 429, and
  each `onUnavailable` mode.
- **Do not add retries to the timeout path.** Every evaluate call is a server-side write; a
  timed-out call may already have been recorded. This is deliberate, not an oversight.
- Tests mock `fetch` through the client's `fetch` option. No live API calls in CI, ever.

## Commit and PR style

Small PRs, one concern each. Describe what breaks if the change is wrong — that is more useful than
describing what it does.

## Releasing

Bump `version` in `package.json` and `VERSION` in `src/version.ts`, update `CHANGELOG.md`, then tag
`vX.Y.Z`. CI publishes to npm with provenance on the tag.

## Questions

Open an issue. For security reports, see [SECURITY.md](SECURITY.md) instead.
