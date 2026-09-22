# AgentTrace

Cryptographic provenance and audit layer for AI agent decisions. Every time an agent
decides something, the SDK records a signed decision manifest — which data sources,
which model, which intermediate steps — and anchors its root on Solana. Anyone holding
the link can verify that the record has not changed, without trusting AgentTrace and
without the model, the prompts or the API keys ever being exposed.

## Live

| | |
|---|---|
| Demo page | https://agenttracewoof.github.io/Agent-Trace/ |
| API | https://agenttrace-api-cr1b.onrender.com |

The page at `/verify` checks an envelope against the chain **in your browser**, with
no backend of ours in the path — a public Solana node is the only thing it needs.
The decision page does read our API, and says so when it cannot.

Everything runs on devnet until milestone M5, and devnet is reset periodically: no
anchor there is meant to outlive a demo. The API runs on a free instance that spins
down when idle, so the first request after a quiet spell can take up to a minute.

## What it is not

It does not run agents, hold funds, or judge whether a decision was *good*. It proves
the decision relied on what it claims to have relied on. Agent identity and reputation
are a different layer; so are spending controls.

## Layout

```
apps/api          ingest, public read, dashboard API
apps/publisher    worker: pending decisions → anchor transaction
apps/web          dashboard + public decision page
packages/manifest  format, hashing, signing, verification — pure, isomorphic
packages/sdk       the client SDK agents integrate
packages/verify    CLI that verifies from public data alone
packages/db        Drizzle schema
packages/shared    Zod schemas shared across the API boundary
```

## Commands

```bash
pnpm install
pnpm gate     # lint + typecheck + test — green before every commit
pnpm dev      # all apps
pnpm lint:fix
```

Requires Node >= 24 and pnpm 9.

## Trust boundaries

The agent's private key never leaves the client's environment, so AgentTrace cannot
forge or backdate a manifest. Storage holds the content but does not vouch for it —
tampering is caught by the on-chain root. The chain attests only that a byte string
existed in a given slot; signature validity is established off-chain by
`packages/verify`, which by design cannot reach the AgentTrace API.
