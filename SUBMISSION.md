# Submission kit (Track A) — internal, not part of the product

## Checklist

- [x] Repo pushed: https://github.com/PugarHuda/jaga-agent
- [ ] Follow @Binance + repost the announcement post
- [x] Video recorded: `jaga-demo.mp4` (118s, silent dashboard capture: paper 50s + demo 65s). Add voice-over per script below, or upload as-is.
- [ ] Reply/quote-repost with video + GitHub link (draft below)
- [ ] Complete the survey: app.binance.com/uni-qr/user-survey/2913aa200aac462c89a737779393f3d4
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

- Network: Binance domains are blocked on Telkomsel — use VPN/alt DNS for the real-MCP config and Track B.
## Track B — step by step (~1h, needs VPN on Telkomsel)

1. Binance app → search "Agent OS" / MCP → create a **dedicated subaccount**, deposit small (e.g. $15–20), generate the MCP access for it. The app shows the official MCP endpoint/config — copy it.
2. Connect Claude Code to it (shape depends on what the app gives you):
   - Remote endpoint: `claude mcp add binance --transport http <ENDPOINT_URL>`
   - Or community stdio server as fallback:
     `claude mcp add binance --env BINANCE_API_KEY=... --env BINANCE_API_SECRET=... -- npx -y binance-mcp-server`
3. In Claude Code: ask for account balance (proves read), then one tiny trade (e.g. market buy $6 BTC) — that's the qualifying MCP trade.
4. Complete the survey from the tweet (open inside the Binance app), follow + repost if not done.
5. Bonus: point Jaga at the same MCP (`config.json`) and let it guard the subaccount for real — that clip also upgrades the Track A video.
