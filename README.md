# 🛡️ Jaga

> **Jaga** (Indonesian: *"to guard"*) — an AI risk-guardian agent for **Binance Agent OS**.

Everyone is building agents that **trade**. Jaga is the agent that **guards** — because Binance itself admits the blind spot: *"We really cannot see the reasoning of what the user's action is."* When your trading agent gets manipulated, hallucinates, or just holds through a crash, Jaga is the independent second agent watching the subaccount and enforcing hard risk rules it cannot talk itself out of.

Built for the **Binance Agent OS Mini Hackathon** (Track A).

## What it does

Jaga connects to a Binance MCP server (Agent OS), watches a dedicated subaccount, and enforces:

| Rule | Trigger | Action |
|---|---|---|
| **stop-loss** | asset drops N% from entry | liquidate position to quote |
| **max-position** | asset exceeds N% of portfolio | sell down the excess |
| **max-drawdown** | portfolio drops N% from peak | de-risk *everything* to stablecoin |

Two layers, deliberately separated:

- **Deterministic guard** (`evaluate()` — pure function, unit-tested): the rules engine. No LLM in the trade path, so no prompt injection can widen a trade.
- **Claude narration**: after a trigger, Claude Opus writes a terse incident report — what tripped, what was done, market context. AI explains; code enforces.

```
┌─────────────┐   MCP    ┌──────────────────┐        ┌────────────────┐
│ Binance MCP │ ◄──────► │  Jaga guard loop │ ─────► │ Claude (report) │
│ (subaccount)│  account │  pure rules      │ trips  └────────────────┘
└─────────────┘  prices  │  evaluate()      │
                 orders   └──────────────────┘
```

## Quick start (safe demo, no keys, no real money)

```bash
npm install
npm test        # 5 assertions on the risk engine
npm run demo    # runs against the bundled mock Binance MCP server
```

The mock market drifts bearish, so within ~30s you'll watch Jaga detect a stop-loss breach, execute the de-risk SELL through MCP, and print its incident report.

## Run against real Binance Agent OS

1. In Binance, create a **dedicated Agent OS subaccount** with a small balance and MCP access (withdrawals are blocked by design — Jaga only ever sells to your quote asset *inside* the subaccount).
2. `cp config.binance.example.json config.json` and fill in your MCP endpoint (HTTP URL) or stdio command + keys.
3. Tool names are **remapped in config**, not code — point `tools.account/prices/order` at whatever your Binance MCP server exposes.
4. Start in `"mode": "propose"` (logs intended orders, executes nothing). Flip to `"execute"` when you trust it.
5. `export ANTHROPIC_API_KEY=...` (optional — without it you get plain-text reports instead of Claude's).
6. `npm start`

## Design choices

- **The LLM never decides trades.** Rules are JSON, evaluation is a pure function, orders are deterministic. This is the answer to the #1 risk of agentic trading.
- **Propose-first default.** Human-in-the-loop until you opt out — mirroring Agent OS's own permission philosophy.
- **MCP-native.** Jaga is itself an MCP *client*, so it composes with any Binance-compatible MCP server today and the official Agent OS server as-is.

## Files

| File | Purpose |
|---|---|
| `jaga.mjs` | agent: MCP client, snapshot, risk engine, executor, Claude report |
| `mock-mcp.mjs` | mock Binance MCP server for demos/tests |
| `test.mjs` | risk-engine self-checks |
| `config.demo.json` / `config.binance.example.json` | demo & real configs |

---

*This is a hackathon project, not financial advice. Trade with money you can afford to lose.*
