# Submission kit (Track A) — internal, not part of the product

## Checklist

- [ ] Push repo to GitHub: `gh repo create jaga --public --source . --push --description "Jaga - AI risk-guardian agent for Binance Agent OS (MCP). Code enforces, AI explains."`
- [ ] Follow @Binance + repost the announcement post
- [ ] Record video (script below), upload to the reply
- [ ] Reply/quote-repost with video + GitHub link (draft below)
- [ ] Complete the survey: app.binance.com/uni-qr/user-survey/2913aa200aac462c89a737779393f3d4
- [ ] Deadline: **Sept 8, 2026, 23:59 UTC**

## Video script (~90 seconds)

Before recording: `set OPENROUTER_API_KEY=...` (or `VENICE_API_KEY` + `set LLM_BASE_URL=https://api.venice.ai/api/v1`) so AI reports show up in the feed, `rm state.json audit.jsonl`, font size up, dashboard at `http://localhost:7777` on one half of the screen, terminal on the other.

1. **(0:00–0:15) Hook.** "Binance Agent OS lets AI agents trade your money. Binance's own VP admits they can't see *why* an agent trades. So what happens when your agent gets prompt-injected or just goes rogue? This is Jaga — the agent that guards the agents."
2. **(0:15–1:00) Live demo.** `npm run demo`. Point at the dashboard: "That red log line is a compromised trading agent piling my portfolio into ETH — 60% concentration. Watch Jaga: detects the breach, executes the trim back to 40% through Binance MCP, logs it to the audit trail, and the AI analyst writes the incident report. Now the market's dropping — stop-loss and circuit breaker fire, everything de-risks to USDC automatically."
3. **(1:00–1:20) The idea.** Show `engine.mjs` for 5 seconds: "The risk engine is a pure function — six rules, seventeen tests, zero LLM in the trade path. Code enforces, AI explains. It's MCP-native, so it points at the official Agent OS server with a config change."
4. **(1:20–1:30) Close.** "Jaga — Indonesian for 'to guard'. Repo in the reply. Give your trading agent a bodyguard."

## Tweet reply draft

> 🛡️ Jaga — the agent that guards the agents. (Track A)
>
> Everyone builds agents that trade. Jaga watches your Agent OS subaccount and enforces 6 hard risk rules a prompt injection can't talk it out of: stop-loss, trailing stop, take-profit, concentration, circuit breaker, max drawdown.
>
> Code enforces. AI explains. Live dashboard + audit trail + AI incident reports. MCP-native.
>
> 🎥 demo below · 💻 github.com/PugarHuda/jaga

## Notes

- Network: Binance domains are blocked on Telkomsel — use VPN/alt DNS for the real-MCP config and Track B.
- Track B (do first, ~1h): Binance app → Agent OS subaccount + MCP key → connect Claude Code/Cursor → 1 small trade → survey.
