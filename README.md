# 🛡️ Jaga

> **Jaga** (Indonesian: *"to guard"*) — an AI risk-guardian agent for **Binance Agent OS**.

Everyone is building agents that **trade**. Jaga is the agent that **guards** — because Binance itself admits the blind spot: *"We really cannot see the reasoning of what the user's action is."* When a trading agent gets prompt-injected, hallucinates, or just holds through a crash, Jaga is the independent second agent watching the subaccount and enforcing hard risk rules it cannot be talked out of.

Built for the **Binance Agent OS Mini Hackathon** (Track A).

## The one idea that matters

**Code enforces. AI explains. Never the other way around.**

The risk engine (`engine.mjs`) is a pure, deterministic, unit-tested function — no LLM anywhere in the trade path, so no prompt injection, market manipulation, or model tantrum can widen exposure. The AI analyst sits *outside* the trade path: narrating incidents, writing periodic threat assessments, telling the human what happened and why. That division of labor is Jaga's answer to the #1 open risk of agentic trading.

## What it does

```
                     ┌──────────────────────────── JAGA ────────────────────────────┐
┌─────────────┐ MCP  │ ┌────────────┐  ┌──────────────────┐  ┌────────────────────┐ │
│ Binance MCP │◄────►│ │  snapshot   │→│  risk engine      │→│ executor (SELL-only │ │
│ (subaccount)│      │ │ acct+prices │  │  6 rules, pure    │  │ propose | execute) │ │
└─────────────┘      │ └────────────┘  │  deterministic    │  └────────────────────┘ │
      ▲              │                 └──────────────────┘        │ trips           │
      │              │      ┌───────────────┬────────────────┬─────┴───────┐         │
┌─────┴───────┐      │ ┌────▼─────┐  ┌──────▼──────┐  ┌──────▼─────┐ ┌─────▼───────┐ │
│ rogue agent │      │ │ live     │  │ audit trail │  │ webhook    │ │ AI analyst: │ │
│ (simulated  │      │ │ dashboard│  │ (JSONL)     │  │ alerts     │ │ reports +   │ │
│  attacker)  │      │ │ SSE      │  │             │  │            │ │ threat scan │ │
└─────────────┘      │ └──────────┘  └─────────────┘  └────────────┘ └─────────────┘ │
                     └────────────────────────────────────────────────────────────────┘
```

**Six deterministic rules** (all thresholds in `config.json`):

| Rule | Trigger | Action | Severity |
|---|---|---|---|
| **stop-loss** | asset drops N% from entry | liquidate to quote | high |
| **trailing-stop** | asset drops N% from its high-water mark | liquidate (locks in gains) | high |
| **take-profit** | asset gains N% from entry | realize the profit | info |
| **max-position** | asset exceeds N% of portfolio | trim the excess only | medium |
| **circuit-breaker** | flash crash: N% drop within a rolling window | liquidate | high |
| **max-drawdown** | portfolio drops N% from peak | de-risk *everything* | critical |

Rules compose — when several fire on one asset, the worst (full) sell wins, deduped into a single order. Jaga only ever **sells to your quote asset inside the subaccount**: it never buys, never withdraws, never widens exposure.

**Around the engine:**

- 📊 **Live dashboard** (`localhost:7777`) — equity curve, positions, drawdown, and a real-time incident feed over SSE. Zero frontend dependencies.
- 🧾 **Audit trail** — every tick, violation, order and report appended to `audit.jsonl`. Reconstruct any decision after the fact.
- 🔔 **Webhook alerts** — Discord/Slack-compatible POST on every intervention.
- 🧠 **AI analyst** — incident reports when rules trip, periodic threat assessments when they don't ("what's closest to tripping"). Provider-agnostic (OpenAI-compatible): OpenRouter, Venice AI, or any compatible endpoint via `OPENROUTER_API_KEY` / `VENICE_API_KEY` / `LLM_API_KEY` + optional `LLM_BASE_URL`/`LLM_MODEL`. Degrades gracefully to deterministic reports without a key.
- 🤖 **Rogue-agent simulation** — the demo ships with an *attacker*: a compromised trading agent that keeps concentrating the portfolio into one asset. Watch Jaga contain it in real time.

## Quick start (safe demo — no keys, no real money)

```bash
npm install
npm test        # 17 assertions on the risk engine
npm run demo    # rogue agent vs. Jaga, live at http://localhost:7777
```

Within ~30 seconds: the rogue agent pumps ETH to 60%+ of the portfolio, Jaga trims it back to the 40% limit through MCP, the market drifts down until stop-losses fire, and every intervention lands on the dashboard, the audit log, and (with `OPENROUTER_API_KEY` or `VENICE_API_KEY` set) an AI incident report.

## Run against real Binance Agent OS

1. In Binance, create a **dedicated Agent OS subaccount** with a small balance and MCP access (withdrawals are blocked by Agent OS design; Jaga is additionally SELL-to-quote-only by construction).
2. `cp config.binance.example.json config.json` — fill in your MCP endpoint (Streamable HTTP URL) or stdio command + keys.
3. Tool names are **remapped in config, not code** — point `tools.account/prices/order` at whatever your Binance MCP server exposes.
4. Start in `"mode": "propose"` (logs and dashboards intended orders, executes nothing). Flip to `"execute"` when you trust it.
5. Optional: `export OPENROUTER_API_KEY=...` (or `VENICE_API_KEY` + `LLM_BASE_URL=https://api.venice.ai/api/v1`) for AI reports, `alerts.webhook` for Discord/Slack pings.
6. `npm start` → open `http://localhost:7777`.

## Design choices

- **The LLM never decides trades.** Rules are JSON, evaluation is a pure function, orders are deterministic, and the engine file imports no AI SDK — auditable at a glance.
- **Propose-first default.** Human-in-the-loop until you explicitly opt out, mirroring Agent OS's own permission philosophy.
- **MCP-native, server-agnostic.** Jaga is an MCP *client* with config-mapped tool names: it works with the official Agent OS server, community Binance MCP servers, and the bundled mock, unchanged.
- **Sell-only by construction.** The executor can only emit SELL-to-quote orders; the blast radius of any bug is "too safe."

## Files

| File | Purpose |
|---|---|
| `engine.mjs` | pure risk engine — 6 rules, no I/O, no LLM |
| `jaga.mjs` | orchestrator: MCP client, executor, audit, alerts, AI analyst |
| `dashboard.mjs` | zero-dependency live dashboard (HTTP + SSE) |
| `mock-mcp.mjs` | mock Binance MCP server + rogue-agent attacker (`--rogue`) |
| `test.mjs` | 17 risk-engine self-checks |
| `config.demo.json` / `config.binance.example.json` | demo & production configs |

---

*Hackathon project, not financial advice. Trade with money you can afford to lose.*
