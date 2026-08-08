# Examples

Run from the repository root after `npm install && npm run build`.

| File | Needs a key? | What it shows |
| --- | --- | --- |
| [`01-basic-gate.mjs`](01-basic-gate.mjs) | yes | Gate one action. Handling all four decisions, plus `degraded`. |
| [`02-agent-tool-loop.mjs`](02-agent-tool-loop.mjs) | yes | One choke point in front of every tool call, with split fail modes. |
| [`03-redaction-dry-run.mjs`](03-redaction-dry-run.mjs) | **no** | Exactly what leaves your process, across all three payload modes. |

```bash
npm install && npm run build
node examples/03-redaction-dry-run.mjs          # no key needed

export SAFENODE_API_KEY=sn_...                  # free key at https://safenode.tech
node examples/01-basic-gate.mjs
```

**Start with `03-redaction-dry-run.mjs`.** It makes no network calls and answers the question most
people have first: *what am I actually sending to a third party?*

The examples import from `../dist/index.js` so they run against the built package. In your own code
the import is `from "safenode-sdk"`.
