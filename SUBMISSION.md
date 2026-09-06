# Submission kit (Track A) — internal, not part of the product

## Checklist

- [x] Repo pushed: https://github.com/PugarHuda/jaga-agent
- [ ] Follow @Binance + repost the announcement post
- [x] Video recorded: `jaga-demo.mp4` (118s, silent dashboard capture: paper 50s + demo 65s). Add voice-over per script below, or upload as-is.
- [ ] Reply/quote-repost with video + GitHub link (draft below)
- [ ] Complete the survey: app.binance.com/uni-qr/user-survey/2913aa200aac462c89a737779393f3d4
- [ ] Track B: SKIPPED by decision (no Binance account connection). Track A only.
- [ ] Deadline: **Sept 8, 2026, 23:59 UTC**

## Video script (~90 seconds)

Before re-recording: `OPENROUTER_API_KEY` is already set as a Windows user env var (open a NEW terminal). Otherwise `set OPENROUTER_API_KEY=...` (or `VENICE_API_KEY` + `set LLM_BASE_URL=https://api.venice.ai/api/v1`) so AI reports show up in the feed, `rm state.json audit.jsonl`, font size up, dashboard at `http://localhost:7777` on one half of the screen, terminal on the other.

1. **(0:00–0:15) Hook.** "Binance Agent OS lets AI agents trade your money. Binance's own VP admits they can't see *why* an agent trades. So what happens when your agent gets prompt-injected or just goes rogue? This is Jaga — the agent that guards the agents."
2. **(0:15–1:00) Live demo.** `npm run paper`. Point at the dashboard: "These are LIVE Binance prices, right now, over the official public data API. That red log line is a compromised trading agent piling my portfolio into ETH — 60% concentration. Watch Jaga: detects the breach, executes the trim back to 40% through MCP, logs it to the audit trail, and the AI analyst writes the incident report." (If the live market is too quiet for stop-losses, cut to `npm run demo` for the crash: "and in a simulated crash — stop-loss, circuit breaker, full de-risk to USDC, automatically.")
3. **(1:00–1:20) The idea.** Show `engine.mjs` for 5 seconds: "The risk engine is a pure function — six rules, seventeen tests, zero LLM in the trade path. Code enforces, AI explains. It's MCP-native, so it points at the official Agent OS server with a config change."
4. **(1:20–1:30) Close.** "Jaga — Indonesian for 'to guard'. Repo in the reply. Give your trading agent a bodyguard."

## Tweet reply draft

> 🛡️ Jaga — the agent that guards the agents. (Track A)
>
> Everyone builds agents that trade. Jaga watches your Agent OS subaccount and enforces 6 hard risk rules a prompt injection can't talk it out of: stop-loss, trailing stop, take-profit, concentration, circuit breaker, max drawdown.
>
> Code enforces. AI explains. Live dashboard + audit trail + AI incident reports. MCP-native.
>
> 🎥 demo below · 💻 github.com/PugarHuda/jaga-agent

## Notes

- 2026-09-06 hardening pass: sequential guard loop (no double sells), LLM timeout off the critical path, config validation, shape normalizers, SHA-256 audit chain + `npm run audit:verify`, Jaga as MCP server (`/mcp`, registered in Claude Code as `jaga`), paper mode = HTTP MCP server with WebSocket prices + order-book fills + real rogue MCP client (`--llm` = LLM under prompt injection). Tests: 18 engine + 31 integration + 18 Playwright e2e. Video v4: crash segment is now the real Aug 2024 crash replayed (no simulated market anywhere); narration updated.

- Network: Binance domains are blocked on Telkomsel — use VPN/alt DNS for the real-MCP config and Track B.
## Track B — step by step (VPN on; verified 2026-09-06)

Official endpoint: `https://agent.binance.com/mcp/agentic` (Streamable HTTP, OAuth 2.1 PKCE, no API keys). Docs: developers.binance.com/en/docs/agent-native/mcp-server/agentic. Reachable through VPN (401 + OAuth metadata confirmed; api.binance.com still 451 without it).

1. `claude mcp add binance-mcp-server --transport http https://agent.binance.com/mcp/agentic` (was registered, removed again 2026-09-06 — Track B skipped).
2. In Claude Code type `/mcp` → pick **binance-mcp-server** → browser opens Binance consent screen → grant **Account + Trade** scopes (skip Transfer). The Agentic subaccount is created automatically on first authorization.
3. Fund the subaccount manually (agent cannot pull from main): https://www.binance.com/en/my/sub-account/asset-management/transfer?asset=USDC — small, e.g. $15–20 USDC.
4. In Claude Code (new session so the tools load): "Use the Binance MCP Server to show BTCUSDT price and 24h change" (proves connect), then "show my Agentic subaccount balance", then "market buy $6 of BTC with USDC on spot" → confirm when it restates the order. That's the qualifying Track B trade. Screenshot it.
5. Survey (mandatory for both tracks), follow + repost if not done.
6. Bonus — Jaga guarding the real subaccount: copy the access token from Claude Code's MCP credentials (`~/.claude/.credentials.json` → mcpOAuth → binance-mcp-server), then
   `cp config.binance.example.json config.json`, `set MCP_BEARER_TOKEN=...`, `node jaga.mjs --config config.json --list-tools` → map real tool names into `config.tools`, keep `"mode": "propose"`, `npm start`. The real server's account/price response shapes may differ from the mock — `takeSnapshot()` in jaga.mjs is the one place to adapt.
