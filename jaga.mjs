// Jaga — AI risk-guardian agent for Binance Agent OS (MCP).
// Watches a subaccount through any Binance-compatible MCP server, enforces hard
// risk rules deterministically (engine.mjs), streams a live dashboard, keeps a
// hash-chained audit trail, fires webhook alerts, exposes itself as an MCP
// server for other agents, and uses an LLM to narrate incidents and run
// periodic threat assessments. The LLM never decides trades.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { evaluate, freshState } from "./engine.mjs";
import { startDashboard } from "./dashboard.mjs";
import { toolResult, parseBalances, parsePrices, valueSnapshot, validateConfig, parseStepSizes, floorToStep, parseThreatLevel } from "./shapes.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};

const CONFIG_PATH = opt("--config", "config.json");
const STATE_PATH = opt("--state", "state.json");
const AUDIT_PATH = opt("--audit", "audit.jsonl");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadJson(path, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

// --- Audit trail: SHA-256 hash chain ---------------------------------------
// Every entry commits to the previous one. Edit, delete or reorder a line and
// `npm run audit:verify` pinpoints it.
let lastHash = (() => {
  try {
    const lines = fs.readFileSync(AUDIT_PATH, "utf8").trim().split("\n");
    return JSON.parse(lines.at(-1)).hash ?? "";
  } catch {
    return "";
  }
})();
function audit(entry) {
  const rec = { ts: new Date().toISOString(), ...entry, prev: lastHash };
  rec.hash = createHash("sha256").update(JSON.stringify(rec)).digest("hex");
  lastHash = rec.hash;
  fs.appendFileSync(AUDIT_PATH, JSON.stringify(rec) + "\n");
  return rec;
}

// --- MCP plumbing ----------------------------------------------------------
async function connectMcp(cfg) {
  const client = new Client({ name: "jaga", version: "2.1.0" });
  const transport = cfg.mcp.url
    ? new StreamableHTTPClientTransport(new URL(cfg.mcp.url), {
        // ponytail: bearer from env (e.g. token copied after OAuth in Claude Code /mcp); no OAuth dance in Jaga itself
        requestInit: { headers: { ...(cfg.mcp.headers ?? {}), ...(process.env.MCP_BEARER_TOKEN ? { authorization: `Bearer ${process.env.MCP_BEARER_TOKEN}` } : {}) } },
      })
    : new StdioClientTransport({ command: cfg.mcp.command, args: cfg.mcp.args ?? [], env: { ...process.env, ...cfg.mcp.env } });
  await client.connect(transport);
  return client;
}

// Optional: a tool that returns exchange filters (Binance exchangeInfo shape or a
// {SYMBOL: stepSize} map). With it, full sells are sized as exact base quantities
// floored to LOT_SIZE — the order Binance actually accepts. Without it, quote-sized.
async function loadStepSizes(mcp, cfg) {
  if (!cfg.tools.symbolInfo) return {};
  try {
    const steps = parseStepSizes(toolResult(await mcp.callTool({ name: cfg.tools.symbolInfo, arguments: cfg.tools.args?.symbolInfo ?? {} })));
    console.log(`📐 LOT_SIZE steps loaded for ${Object.keys(steps).length} symbols`);
    return steps;
  } catch (e) {
    console.error("symbolInfo unavailable, falling back to quote-sized orders:", e.message);
    return {};
  }
}

async function takeSnapshot(mcp, cfg) {
  const a = cfg.tools.args ?? {};
  const balances = parseBalances(toolResult(await mcp.callTool({ name: cfg.tools.account, arguments: a.account ?? {} })));
  const prices = parsePrices(toolResult(await mcp.callTool({ name: cfg.tools.prices, arguments: a.prices ?? {} })));
  return valueSnapshot(balances, prices, cfg.rules.quote);
}

// counterfactual: what the assets Jaga sold would be worth if we'd kept holding.
// positive = losses avoided by intervening.
function damageAvoided(ledger, snapshot) {
  let usd = 0;
  for (const l of ledger) {
    const now = snapshot.priceOf(l.asset);
    if (now) usd += (l.fillPrice - now) * l.qty;
  }
  return usd;
}

// --- Alerts (Discord / Slack-compatible webhook) ---------------------------
async function alert(cfg, text) {
  if (!cfg.alerts?.webhook) return;
  try {
    const res = await fetch(cfg.alerts.webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text.slice(0, 1900), text }), // content=Discord, text=Slack/generic
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) console.error(`alert failed: HTTP ${res.status}`);
  } catch (e) {
    console.error("alert failed:", e.message);
  }
}

// --- LLM analyst: incident narration + periodic threat assessment ----------
// Provider-agnostic (OpenAI-compatible chat completions): works with OpenRouter,
// Venice AI, or any compatible endpoint. Configure via env:
//   LLM_API_KEY (or OPENROUTER_API_KEY / VENICE_API_KEY)
//   LLM_BASE_URL (default https://openrouter.ai/api/v1; Venice: https://api.venice.ai/api/v1)
//   LLM_MODEL    (default openai/gpt-4o-mini)
// The LLM only ever narrates — it has no path to the executor.
async function askLLM(cfg, system, payload, maxTokens = 600) {
  const key = process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || process.env.VENICE_API_KEY;
  if (!key) return null;
  const base = process.env.LLM_BASE_URL || cfg.llm?.baseUrl || "https://openrouter.ai/api/v1";
  const model = process.env.LLM_MODEL || cfg.llm?.model || "openai/gpt-4o-mini"; // ponytail: cheap + reliable; any OpenAI-compatible model works
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
    signal: AbortSignal.timeout(cfg.llm?.timeoutMs ?? 25000), // a hung LLM must never stall the guard loop
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
      "You are Jaga's analyst. Given portfolio snapshot, price history and active risk rules, write a threat assessment. First line exactly 'LEVEL: LOW' or 'LEVEL: MEDIUM' or 'LEVEL: HIGH'. Then the single biggest exposure and what rule is closest to tripping. Max 80 words, terse.",
      { snapshot, history: state.history, entries: state.entries, peak: state.peak, rules }
    );
  } catch (e) {
    console.error("LLM advisor failed:", e.message);
    return null;
  }
}

// --- Execution & approvals -------------------------------------------------
async function execute(ctx, a) {
  const { mcp, cfg, dash } = ctx;
  let res;
  try {
    res = toolResult(
      await mcp.callTool({
        name: cfg.tools.order,
        arguments:
          a.full && a.qty && ctx.steps[a.symbol]
            ? { symbol: a.symbol, side: a.side, type: "MARKET", quantity: floorToStep(a.qty, ctx.steps[a.symbol]) } // exact, never over-asks
            : { symbol: a.symbol, side: a.side, type: "MARKET", quoteOrderQty: a.usd },
      })
    );
  } catch (e) {
    console.error(`   ❌ ORDER FAILED ${a.side} ${a.symbol} ~$${a.usd}: ${e.message}`);
    audit({ type: "action", ...a, status: "ERROR", error: e.message });
    dash?.emit({ type: "violation", rule: "order-failed", text: `${a.side} ${a.symbol} ~$${a.usd}: ${e.message}` });
    return;
  }
  const status = res.status ?? "ok";
  audit({ type: "action", ...a, status, fillPrice: res.fillPrice, executedQty: res.executedQty, fee: res.fee, reason: res.reason });
  if (status !== "FILLED") {
    // REJECTED / EXPIRED / partial: not an intervention — say so loudly, retry next tick
    console.log(`   ❌ ORDER ${status} ${a.side} ${a.symbol} ~${a.usd}${res.reason ? `: ${res.reason}` : ""}`);
    dash?.emit({ type: "violation", rule: "order-" + String(status).toLowerCase(), text: `${a.side} ${a.symbol} ~${a.usd}${res.reason ? `: ${res.reason}` : ""}` });
    return false;
  }
  const asset = a.symbol.slice(0, -cfg.rules.quote.length);
  const qty = Number(res.executedQty) || 0;
  const fillPrice = Number(res.fillPrice) || (qty ? Number(res.cummulativeQuoteQty ?? a.usd) / qty : 0);
  if (qty && fillPrice) ctx.ledger.push({ asset, qty, fillPrice });
  if (ctx.ledger.length > 200) ctx.ledger.shift(); // ponytail: rolling window, not forever
  ctx.interventions++;
  console.log(`   ✅ EXECUTED ${a.side} ${a.symbol} ~${a.usd}: FILLED`);
  dash?.emit({ type: "action", rule: "executed", text: `${a.side} ${a.symbol} ~${a.usd} → FILLED` });
  return true;
}

// Emergency stop: the human hits the red button → everything sellable goes to quote
// NOW, regardless of mode. Deterministic, audited, no LLM involved.
async function panic(ctx) {
  const s = await takeSnapshot(ctx.mcp, ctx.cfg); // fresh: never size a sell off a stale tick
  const targets = s.positions.filter((p) => p.usd >= ctx.cfg.rules.minTradeUsd);
  console.log(`🚨 PANIC: human-triggered de-risk of ${targets.length} position(s)`);
  audit({ type: "panic", positions: targets.map((p) => p.asset) });
  ctx.dash?.emit({ type: "violation", rule: "🚨 panic", text: `human-triggered de-risk: selling ${targets.map((p) => p.asset).join(", ") || "nothing (already in quote)"}` });
  for (const p of targets) await execute(ctx, { side: "SELL", symbol: `${p.asset}${s.quote}`, usd: Math.round(p.usd * 100) / 100, full: true, qty: p.qty });
  for (const id of ctx.pending.keys()) ctx.dash?.emit({ type: "decision", id }); // proposals are moot now — clear the dashboard too
  ctx.pending.clear();
  persist(ctx);
}

// Prometheus text exposition — scrape http://127.0.0.1:7777/metrics
function metrics(ctx) {
  const s = ctx.last;
  const dd = s && ctx.state.peak ? ((ctx.state.peak - s.total) / ctx.state.peak) * 100 : 0;
  const lines = [
    ["jaga_portfolio_total", "gauge", s?.total ?? 0],
    ["jaga_portfolio_peak", "gauge", ctx.state.peak ?? 0],
    ["jaga_drawdown_pct", "gauge", dd],
    ["jaga_quote_free", "gauge", s?.quoteFree ?? 0],
    ["jaga_interventions_total", "counter", ctx.interventions],
    ["jaga_damage_avoided", "gauge", s ? damageAvoided(ctx.ledger, s) : 0],
    ["jaga_ticks_total", "counter", ctx.ticks],
    ["jaga_errors_total", "counter", ctx.errors],
    ["jaga_pending_proposals", "gauge", ctx.pending.size],
    ["jaga_last_violations", "gauge", ctx.lastViolations.length],
  ];
  let out = lines.map(([n, t, v]) => `# TYPE ${n} ${t}\n${n} ${Number(v)}`).join("\n") + "\n";
  out += "# TYPE jaga_position_usd gauge\n" + (s?.positions ?? []).map((p) => `jaga_position_usd{asset="${p.asset}"} ${p.usd}`).join("\n") + "\n";
  return out;
}

// /healthz — for uptime monitors, k8s probes, or a glance
function health(ctx) {
  const age = ctx.lastTickAt ? (Date.now() - Date.parse(ctx.lastTickAt)) / 1000 : null;
  const budget = (ctx.cfg.intervalSec ?? 10) * 3;
  return {
    ok: age !== null && age < budget,
    uptimeSec: Math.round(process.uptime()),
    lastTickAt: ctx.lastTickAt,
    lastTickAgeSec: age === null ? null : Math.round(age),
    ticks: ctx.ticks,
    errors: ctx.errors,
    interventions: ctx.interventions,
    mode: ctx.cfg.rules.mode,
    mcp: ctx.cfg.mcp.url ?? ctx.cfg.mcp.command,
  };
}

// The equity curve survives restarts: replay the last ticks from the audit trail.
function replayEquity(dash) {
  try {
    const series = fs
      .readFileSync(AUDIT_PATH, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === "tick")
      .slice(-300)
      .map((e) => e.total);
    if (series.length) dash.seed(series);
  } catch {}
}

// Hot reload: edit config.json while Jaga runs → new thresholds apply on the next
// tick (validated first; a bad edit is rejected and the old rules stay).
function watchConfig(ctx) {
  let timer;
  try {
    fs.watch(CONFIG_PATH, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const next = loadJson(CONFIG_PATH, null);
        const errs = next ? validateConfig(next) : ["config unreadable"];
        if (errs.length) {
          console.error("⚠️  config change rejected:\n  " + errs.join("\n  "));
          ctx.dash?.emit({ type: "violation", rule: "config-rejected", text: errs.join("; ") });
          return;
        }
        const before = JSON.stringify(ctx.cfg.rules);
        Object.assign(ctx.cfg, { rules: next.rules, intervalSec: next.intervalSec, advisor: next.advisor, alerts: next.alerts, llm: next.llm });
        if (before !== JSON.stringify(next.rules)) {
          console.log("♻️  rules reloaded from " + CONFIG_PATH);
          audit({ type: "config", rules: next.rules });
          ctx.dash?.emit({ type: "advisor", rule: "♻️ config", text: `rules reloaded: mode=${next.rules.mode} maxPos=${next.rules.maxPositionPct}% SL=${next.rules.stopLossPct}% DD=${next.rules.maxDrawdownPct}%` });
        }
      }, 300);
    });
  } catch (e) {
    console.error("config watch unavailable:", e.message);
  }
}

function propose(ctx, a) {
  // one open proposal per symbol — re-proposing the same breach every tick is noise
  if ([...ctx.pending.values()].some((p) => p.symbol === a.symbol)) return;
  const id = crypto.randomUUID(); // unguessable — an attacker can't forge approvals blind
  ctx.pending.set(id, a);
  console.log(`   📋 PROPOSED ${a.side} ${a.symbol} ~$${a.usd} (awaiting approval on dashboard)`);
  audit({ type: "proposal", id, ...a });
  ctx.dash?.emit({ type: "proposal", id, rule: "proposed", text: `${a.side} ${a.symbol} ~$${a.usd}` });
}

async function onDecision(ctx, id, approve) {
  const a = ctx.pending.get(id);
  if (!a) return;
  ctx.pending.delete(id);
  audit({ type: "decision", id, approve, ...a });
  if (approve) await execute(ctx, a);
  else ctx.dash?.emit({ type: "violation", rule: "rejected", text: `human rejected ${a.side} ${a.symbol} ~$${a.usd}` });
  persist(ctx);
}

function persist(ctx) {
  fs.writeFileSync(STATE_PATH, JSON.stringify({ engine: ctx.state, ledger: ctx.ledger }, null, 2));
}

// --- Jaga as an MCP server -------------------------------------------------
// Other agents (Claude Code, a trading agent, an ops bot) can ask the guardian
// what it sees. Read-only by design: approvals stay with the human on the dashboard.
function jagaMcpHandler(ctx) {
  // structuredContent must be an object per MCP spec — arrays get wrapped
  const json = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }], structuredContent: Array.isArray(obj) ? { items: obj } : obj });
  return async (req, res) => {
    const server = new McpServer({ name: "jaga", version: "2.1.0" });
    server.tool("risk_status", "Current portfolio snapshot, drawdown, active rules, last violations, interventions and damage avoided", async () => {
      const s = ctx.last;
      return json({
        mode: ctx.cfg.rules.mode,
        rules: ctx.cfg.rules,
        total: s?.total ?? null,
        peak: ctx.state.peak,
        drawdownPct: s && ctx.state.peak ? ((ctx.state.peak - s.total) / ctx.state.peak) * 100 : 0,
        positions: s?.positions ?? [],
        unpriced: s?.unpriced ?? [],
        quoteFree: s?.quoteFree ?? 0,
        lastViolations: ctx.lastViolations,
        interventions: ctx.interventions,
        damageAvoided: s ? damageAvoided(ctx.ledger, s) : 0,
        lastTick: ctx.lastTickAt,
      });
    });
    server.tool("pending_proposals", "Orders proposed by the risk engine and awaiting human approval (propose mode)", async () =>
      json([...ctx.pending.entries()].map(([id, a]) => ({ id, ...a })))
    );
    server.tool("audit_tail", "Last N entries of the hash-chained audit trail", { n: z.number().int().min(1).max(200).default(20) }, async ({ n }) => {
      let lines = [];
      try {
        lines = fs.readFileSync(AUDIT_PATH, "utf8").trim().split("\n").slice(-n).map((l) => JSON.parse(l));
      } catch {}
      return json(lines);
    });
    server.prompt("incident_briefing", "Brief the operator on Jaga's recent interventions and current exposure", async () => {
      const st = ctx.last;
      let recent = [];
      try {
        recent = fs.readFileSync(AUDIT_PATH, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => ["violation", "action", "panic", "decision"].includes(e.type)).slice(-15);
      } catch {}
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `You are briefing the human operator of a crypto subaccount guarded by Jaga (deterministic risk rules; you only explain, never trade).\nMode: ${ctx.cfg.rules.mode}. Rules: ${JSON.stringify(ctx.cfg.rules)}.\nPortfolio now: ${JSON.stringify({ total: st?.total, quoteFree: st?.quoteFree, positions: st?.positions })}.\nRecent audit entries (oldest first): ${JSON.stringify(recent)}.\nIn under 150 words: what happened, what Jaga did, what is closest to tripping next, and one concrete recommendation.`,
            },
          },
        ],
      };
    });
    server.resource("audit-trail", "jaga://audit", { description: "Hash-chained audit trail (JSONL, last 200 entries)", mimeType: "application/x-ndjson" }, async (uri) => {
      let text = "";
      try {
        text = fs.readFileSync(AUDIT_PATH, "utf8").trim().split("\n").slice(-200).join("\n");
      } catch {}
      return { contents: [{ uri: uri.href, mimeType: "application/x-ndjson", text }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); // stateless: one server per request
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };
}

// --- Main loop -------------------------------------------------------------
async function tick(ctx) {
  const { mcp, cfg, dash } = ctx;
  const snapshot = await takeSnapshot(mcp, cfg);
  snapshot.ts = Date.now();
  const { violations, actions, state } = evaluate(snapshot, cfg.rules, ctx.state);
  ctx.state = state;
  ctx.ticks++;
  ctx.last = snapshot;
  ctx.lastViolations = violations;
  ctx.lastTickAt = new Date().toISOString();
  const avoided = damageAvoided(ctx.ledger, snapshot);

  console.log(
    `[${ctx.lastTickAt}] total=${snapshot.total.toFixed(2)} ${cfg.rules.quote} | avoided=${avoided.toFixed(2)} | ` +
      snapshot.positions.map((p) => `${p.asset}=${p.usd.toFixed(2)}`).join(" ")
  );
  audit({ type: "tick", total: snapshot.total, avoided, positions: snapshot.positions });
  dash?.emit({
    type: "tick",
    total: snapshot.total,
    peak: state.peak,
    avoided,
    quote: snapshot.quote,
    quoteFree: snapshot.quoteFree,
    positions: snapshot.positions.map((p) => ({ ...p, entry: state.entries[p.asset]?.entry ?? null })),
    unpriced: snapshot.unpriced,
    mode: cfg.rules.mode,
    limits: { maxDrawdownPct: cfg.rules.maxDrawdownPct, maxPositionPct: cfg.rules.maxPositionPct },
  });

  if (violations.length) {
    console.log("⚠️  VIOLATIONS:");
    for (const v of violations) {
      console.log(`   [${v.rule}] ${v.detail}`);
      audit({ type: "violation", ...v });
      dash?.emit({ type: "violation", rule: v.rule, text: v.detail });
    }
    for (const a of actions) {
      if (cfg.rules.mode === "execute") await execute(ctx, a);
      else propose(ctx, a);
    }
    // narration runs off the critical path: the next tick never waits for an LLM
    ctx.inflight = narrate(cfg, snapshot, violations, actions, cfg.rules.mode).then(async (report) => {
      console.log("\n🧠 Jaga report:\n" + report + "\n");
      audit({ type: "report", report });
      dash?.emit({ type: "report", rule: "🧠 report", text: report });
      await alert(cfg, `🛡️ Jaga intervention\n${report}`);
    });
  } else if (cfg.advisor?.everyTicks && ctx.ticks % cfg.advisor.everyTicks === 0) {
    ctx.inflight = threatAssessment(cfg, snapshot, state, cfg.rules).then((assessment) => {
      if (!assessment) return;
      const level = parseThreatLevel(assessment);
      console.log("🔭 threat assessment:\n" + assessment + "\n");
      audit({ type: "advisor", level, assessment });
      dash?.emit({ type: "advisor", rule: "🔭 advisor", level, text: assessment });
    });
  }

  persist(ctx);
}

async function main() {
  const cfg = loadJson(CONFIG_PATH, null);
  if (!cfg) {
    console.error(`Missing ${CONFIG_PATH}. Copy config.demo.json or config.binance.example.json.`);
    process.exit(1);
  }
  const errs = validateConfig(cfg);
  if (errs.length) {
    console.error("❌ invalid config:\n  " + errs.join("\n  "));
    process.exit(1);
  }
  const persisted = loadJson(STATE_PATH, {});
  const ctx = {
    cfg,
    state: persisted.engine ?? freshState(),
    ledger: persisted.ledger ?? [],
    pending: new Map(),
    ticks: 0,
    interventions: 0,
    errors: 0,
    steps: {},
    inflight: null,
    last: null,
    lastViolations: [],
    lastTickAt: null,
    dash: null,
    mcp: null,
  };
  ctx.dash = cfg.dashboard?.port
    ? startDashboard(cfg.dashboard.port, {
        onDecision: (id, approve) => onDecision(ctx, id, approve),
        onPanic: () => panic(ctx),
        metrics: () => metrics(ctx),
        health: () => health(ctx),
        mcp: jagaMcpHandler(ctx),
        host: cfg.dashboard.host,
        token: process.env.JAGA_DASHBOARD_TOKEN || cfg.dashboard.token || null,
      })
    : null;
  if (ctx.dash) replayEquity(ctx.dash);
  watchConfig(ctx);
  audit({ type: "start", mode: cfg.rules.mode, mcp: cfg.mcp.url ?? cfg.mcp.command });
  const shutdown = async (sig) => {
    console.log(`\n⏹  ${sig}: shutting down cleanly`);
    audit({ type: "shutdown", signal: sig, ticks: ctx.ticks, interventions: ctx.interventions });
    persist(ctx);
    try {
      ctx.dash?.close();
      await ctx.mcp?.close();
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  console.log(`Jaga 🛡️  guarding via MCP (${cfg.mcp.url ?? cfg.mcp.command}) — mode=${cfg.rules.mode}`);
  ctx.mcp = await connectMcp(cfg);
  ctx.steps = await loadStepSizes(ctx.mcp, cfg);
  if (flag("--list-tools")) {
    // discover real tool names + schemas so config.tools can be mapped without guessing
    for (const t of (await ctx.mcp.listTools()).tools) console.log(`\n## ${t.name}\n${t.description ?? ""}\n${JSON.stringify(t.inputSchema)}`);
    process.exit(0);
  }
  await tick(ctx);
  if (flag("--once")) {
    await ctx.inflight; // let the report land before exiting
    process.exit(0);
  }

  // sequential loop: a slow tick (network, MCP) can never overlap the next one
  // and double-execute a sell. Three failures in a row → reconnect the MCP client.
  let failures = 0;
  for (;;) {
    await sleep((cfg.intervalSec ?? 10) * 1000);
    try {
      await tick(ctx);
      failures = 0;
    } catch (e) {
      console.error("tick failed:", e.message);
      ctx.errors++;
      audit({ type: "error", error: e.message });
      if (++failures >= 3) {
        console.error("↻ reconnecting MCP…");
        try {
          await ctx.mcp.close();
        } catch {}
        try {
          ctx.mcp = await connectMcp(cfg);
          failures = 0;
        } catch (e2) {
          console.error("reconnect failed:", e2.message);
        }
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
