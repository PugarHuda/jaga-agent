// Jaga — AI risk-guardian agent for Binance Agent OS (MCP).
// Watches a subaccount through any Binance-compatible MCP server, enforces hard
// risk rules deterministically (engine.mjs), streams a live dashboard, keeps an
// audit trail, fires webhook alerts, and uses Claude to narrate incidents and
// run periodic threat assessments. The LLM never decides trades.
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { evaluate, freshState } from "./engine.mjs";
import { startDashboard } from "./dashboard.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};

const CONFIG_PATH = opt("--config", "config.json");
const STATE_PATH = opt("--state", "state.json");
const AUDIT_PATH = opt("--audit", "audit.jsonl");

function loadJson(path, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function audit(entry) {
  fs.appendFileSync(AUDIT_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

// --- MCP plumbing ----------------------------------------------------------
async function connectMcp(cfg) {
  const client = new Client({ name: "jaga", version: "2.0.0" });
  const transport = cfg.mcp.url
    ? new StreamableHTTPClientTransport(new URL(cfg.mcp.url))
    : new StdioClientTransport({ command: cfg.mcp.command, args: cfg.mcp.args ?? [], env: { ...process.env, ...cfg.mcp.env } });
  await client.connect(transport);
  return client;
}

function parseToolJson(res) {
  const text = res.content?.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text);
}

async function takeSnapshot(mcp, cfg) {
  const account = parseToolJson(await mcp.callTool({ name: cfg.tools.account, arguments: {} }));
  const prices = parseToolJson(await mcp.callTool({ name: cfg.tools.prices, arguments: {} }));
  const quote = cfg.rules.quote;
  let quoteFree = 0;
  const positions = [];
  for (const b of account.balances ?? []) {
    const qty = Number(b.free);
    if (qty <= 0) continue;
    if (b.asset === quote) {
      quoteFree = qty;
      continue;
    }
    const price = Number(prices[`${b.asset}${quote}`]);
    if (!price) continue; // ponytail: assets without a direct quote pair are ignored
    positions.push({ asset: b.asset, qty, price, usd: qty * price });
  }
  const total = quoteFree + positions.reduce((s, p) => s + p.usd, 0);
  return { positions, quote, quoteFree, total };
}

// --- Alerts (Discord/Slack/Telegram-style webhook) -------------------------
async function alert(cfg, text) {
  if (!cfg.alerts?.webhook) return;
  try {
    await fetch(cfg.alerts.webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text, text }), // content=Discord, text=Slack/generic
    });
  } catch (e) {
    console.error("alert failed:", e.message);
  }
}

// --- LLM analyst: incident narration + periodic threat assessment ----------
// Provider-agnostic (OpenAI-compatible chat completions): works with OpenRouter,
// Venice AI, or any compatible endpoint. Configure via env:
//   LLM_API_KEY (or OPENROUTER_API_KEY / VENICE_API_KEY)
//   LLM_BASE_URL (default https://openrouter.ai/api/v1; Venice: https://api.venice.ai/api/v1)
//   LLM_MODEL    (default openrouter/auto)
// The LLM only ever narrates — it has no path to the executor.
async function askLLM(cfg, system, payload, maxTokens = 600) {
  const key = process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || process.env.VENICE_API_KEY;
  if (!key) return null;
  const base = process.env.LLM_BASE_URL || cfg.llm?.baseUrl || "https://openrouter.ai/api/v1";
  const model = process.env.LLM_MODEL || cfg.llm?.model || "openrouter/auto";
  const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(payload) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).choices?.[0]?.message?.content ?? null;
}

async function narrate(cfg, snapshot, violations, actions, mode) {
  const plain = violations.map((v) => `[${v.rule}] ${v.detail}`).join("\n");
  try {
    return (
      (await askLLM(
        cfg,
        "You are Jaga, a crypto portfolio risk guardian. Write a terse incident report (max 120 words): what tripped, what action is being taken, and one sentence of market-context advice. No hedging, no disclaimers.",
        { snapshot, violations, actions, mode }
      )) ?? plain
    );
  } catch (e) {
    console.error("LLM narrate failed:", e.message);
    return plain; // no key or API unreachable — deterministic report still ships
  }
}

async function threatAssessment(cfg, snapshot, state, rules) {
  try {
    return await askLLM(
      cfg,
      "You are Jaga's analyst. Given portfolio snapshot, price history and active risk rules, write a threat assessment: risk level (LOW/MEDIUM/HIGH), the single biggest exposure, and what rule is closest to tripping. Max 80 words, terse.",
      { snapshot, history: state.history, entries: state.entries, peak: state.peak, rules }
    );
  } catch (e) {
    console.error("LLM advisor failed:", e.message);
    return null;
  }
}

// --- Main loop -------------------------------------------------------------
async function tick(ctx) {
  const { mcp, cfg, dash } = ctx;
  const snapshot = await takeSnapshot(mcp, cfg);
  const { violations, actions, state } = evaluate(snapshot, cfg.rules, ctx.state);
  ctx.state = state;
  ctx.ticks++;

  console.log(
    `[${new Date().toISOString()}] total=${snapshot.total.toFixed(2)} ${cfg.rules.quote} | ` +
      snapshot.positions.map((p) => `${p.asset}=${p.usd.toFixed(2)}`).join(" ")
  );
  audit({ type: "tick", total: snapshot.total, positions: snapshot.positions });
  dash?.emit({
    type: "tick",
    total: snapshot.total,
    peak: state.peak,
    quote: snapshot.quote,
    quoteFree: snapshot.quoteFree,
    positions: snapshot.positions,
    mode: cfg.rules.mode,
  });

  if (violations.length) {
    console.log("⚠️  VIOLATIONS:");
    for (const v of violations) {
      console.log(`   [${v.rule}] ${v.detail}`);
      audit({ type: "violation", ...v });
      dash?.emit({ type: "violation", rule: v.rule, text: v.detail });
    }
    for (const a of actions) {
      if (cfg.rules.mode === "execute") {
        const res = await mcp.callTool({
          name: cfg.tools.order,
          arguments: { symbol: a.symbol, side: a.side, type: "MARKET", quoteOrderQty: a.usd },
        });
        const status = parseToolJson(res).status ?? "ok";
        console.log(`   ✅ EXECUTED ${a.side} ${a.symbol} ~$${a.usd}: ${status}`);
        audit({ type: "action", ...a, status });
        dash?.emit({ type: "action", rule: "executed", text: `${a.side} ${a.symbol} ~$${a.usd} → ${status}` });
      } else {
        console.log(`   📋 PROPOSED ${a.side} ${a.symbol} ~$${a.usd} (mode=propose, not executed)`);
        audit({ type: "proposal", ...a });
        dash?.emit({ type: "action", rule: "proposed", text: `${a.side} ${a.symbol} ~$${a.usd} (awaiting human)` });
      }
    }
    const report = await narrate(cfg, snapshot, violations, actions, cfg.rules.mode);
    console.log("\n🧠 Jaga report:\n" + report + "\n");
    audit({ type: "report", report });
    dash?.emit({ type: "report", rule: "🧠 report", text: report });
    await alert(cfg, `🛡️ Jaga intervention\n${report}`);
  } else if (cfg.advisor?.everyTicks && ctx.ticks % cfg.advisor.everyTicks === 0) {
    const assessment = await threatAssessment(cfg, snapshot, state, cfg.rules);
    if (assessment) {
      console.log("🔭 threat assessment:\n" + assessment + "\n");
      audit({ type: "advisor", assessment });
      dash?.emit({ type: "advisor", rule: "🔭 advisor", text: assessment });
    }
  }

  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

async function main() {
  const cfg = loadJson(CONFIG_PATH, null);
  if (!cfg) {
    console.error(`Missing ${CONFIG_PATH}. Copy config.demo.json or config.binance.example.json.`);
    process.exit(1);
  }
  const ctx = {
    cfg,
    state: loadJson(STATE_PATH, freshState()),
    ticks: 0,
    dash: cfg.dashboard?.port ? startDashboard(cfg.dashboard.port) : null,
    mcp: null,
  };
  console.log(`Jaga 🛡️  guarding via MCP (${cfg.mcp.url ?? cfg.mcp.command}) — mode=${cfg.rules.mode}`);
  ctx.mcp = await connectMcp(cfg);
  await tick(ctx);
  if (flag("--once")) process.exit(0);
  setInterval(async () => {
    try {
      await tick(ctx);
    } catch (e) {
      console.error("tick failed:", e.message);
    }
  }, (cfg.intervalSec ?? 10) * 1000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
