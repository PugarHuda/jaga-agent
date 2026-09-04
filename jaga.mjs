// Jaga — AI risk-guardian agent for Binance Agent OS (MCP).
// Watches a subaccount through any Binance-compatible MCP server, enforces
// hard risk rules deterministically, and uses Claude to narrate incidents.
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};

const CONFIG_PATH = opt("--config", "config.json");
const STATE_PATH = opt("--state", "state.json");

export function loadJson(path, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

// --- Pure risk engine ------------------------------------------------------
// snapshot: { positions: [{asset, qty, price, usd}], quote, quoteFree, total }
// state:    { peak, entries: {ASSET: entryPrice} }
// Returns { violations, actions, state } — actions are SELL-to-quote orders.
export function evaluate(snapshot, rules, state) {
  const s = {
    peak: Math.max(state.peak ?? 0, snapshot.total),
    entries: { ...state.entries },
  };
  const violations = [];
  const sellUsd = {}; // asset -> usd to liquidate (max wins)

  for (const p of snapshot.positions) {
    if (p.usd < rules.minTradeUsd) continue; // dust — not worth guarding or spamming about
    if (s.entries[p.asset] == null) s.entries[p.asset] = p.price; // first sight = entry

    const entry = s.entries[p.asset];
    const dropPct = ((entry - p.price) / entry) * 100;
    if (dropPct >= rules.stopLossPct) {
      violations.push({
        rule: "stop-loss",
        asset: p.asset,
        detail: `${p.asset} down ${dropPct.toFixed(1)}% from entry ${entry.toFixed(2)} (limit ${rules.stopLossPct}%)`,
      });
      sellUsd[p.asset] = Math.max(sellUsd[p.asset] ?? 0, p.usd);
    }

    const pct = (p.usd / snapshot.total) * 100;
    if (pct > rules.maxPositionPct) {
      const excess = p.usd - (snapshot.total * rules.maxPositionPct) / 100;
      violations.push({
        rule: "max-position",
        asset: p.asset,
        detail: `${p.asset} is ${pct.toFixed(1)}% of portfolio (limit ${rules.maxPositionPct}%)`,
      });
      sellUsd[p.asset] = Math.max(sellUsd[p.asset] ?? 0, excess);
    }
  }

  const ddPct = s.peak > 0 ? ((s.peak - snapshot.total) / s.peak) * 100 : 0;
  if (ddPct >= rules.maxDrawdownPct) {
    violations.push({
      rule: "max-drawdown",
      asset: "*",
      detail: `portfolio down ${ddPct.toFixed(1)}% from peak ${s.peak.toFixed(2)} (limit ${rules.maxDrawdownPct}%) — de-risking everything`,
    });
    for (const p of snapshot.positions) sellUsd[p.asset] = p.usd; // supersedes partial sells
  }

  const actions = Object.entries(sellUsd)
    .filter(([, usd]) => usd >= rules.minTradeUsd)
    .map(([asset, usd]) => ({
      side: "SELL",
      symbol: `${asset}${snapshot.quote}`,
      usd: Math.round(usd * 100) / 100,
    }));

  // reset entry after a liquidation so we don't re-trigger on the remainder
  for (const a of actions) delete s.entries[a.symbol.replace(snapshot.quote, "")];

  return { violations, actions, state: s };
}

// --- MCP plumbing ----------------------------------------------------------
async function connectMcp(cfg) {
  const client = new Client({ name: "jaga", version: "1.0.0" });
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
  // account: { balances: [{asset, free}] }; prices: { "BTCUSDC": 12345, ... }
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

// --- Claude narrative ------------------------------------------------------
async function narrate(snapshot, violations, actions, mode) {
  const plain = violations.map((v) => `[${v.rule}] ${v.detail}`).join("\n");
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    const response = await client.beta.messages.create({
    model: "claude-opus-5",
    max_tokens: 4096,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system:
      "You are Jaga, a crypto portfolio risk guardian. Write a terse incident report (max 120 words): what tripped, what action is being taken, and one sentence of market-context advice. No hedging, no disclaimers.",
    messages: [
      {
        role: "user",
        content: JSON.stringify({ snapshot, violations, actions, mode }),
      },
    ],
  });
    if (response.stop_reason === "refusal") return plain;
    return response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  } catch {
    return plain; // no credentials or API unreachable — deterministic report still ships
  }
}

// --- Main loop -------------------------------------------------------------
async function tick(mcp, cfg, state) {
  const snapshot = await takeSnapshot(mcp, cfg);
  const { violations, actions, state: next } = evaluate(snapshot, cfg.rules, state);
  const stamp = new Date().toISOString();
  console.log(
    `[${stamp}] total=${snapshot.total.toFixed(2)} ${cfg.rules.quote} | ` +
      snapshot.positions.map((p) => `${p.asset}=${p.usd.toFixed(2)}`).join(" ")
  );

  if (violations.length) {
    console.log("⚠️  VIOLATIONS:");
    for (const v of violations) console.log(`   [${v.rule}] ${v.detail}`);
    for (const a of actions) {
      if (cfg.rules.mode === "execute") {
        const res = await mcp.callTool({
          name: cfg.tools.order,
          arguments: { symbol: a.symbol, side: a.side, type: "MARKET", quoteOrderQty: a.usd },
        });
        console.log(`   ✅ EXECUTED ${a.side} ${a.symbol} ~$${a.usd}:`, parseToolJson(res).status ?? "ok");
      } else {
        console.log(`   📋 PROPOSED ${a.side} ${a.symbol} ~$${a.usd} (mode=propose, not executed)`);
      }
    }
    console.log("\n🧠 Jaga report:\n" + (await narrate(snapshot, violations, actions, cfg.rules.mode)) + "\n");
  }

  fs.writeFileSync(STATE_PATH, JSON.stringify(next, null, 2));
  return next;
}

async function main() {
  const cfg = loadJson(CONFIG_PATH, null);
  if (!cfg) {
    console.error(`Missing ${CONFIG_PATH}. Copy config.demo.json or config.binance.example.json.`);
    process.exit(1);
  }
  let state = loadJson(STATE_PATH, { peak: 0, entries: {} });
  console.log(`Jaga 🛡️  guarding via MCP (${cfg.mcp.url ?? cfg.mcp.command}) — mode=${cfg.rules.mode}`);
  const mcp = await connectMcp(cfg);
  state = await tick(mcp, cfg, state);
  if (!flag("--once")) {
    setInterval(async () => {
      try {
        state = await tick(mcp, cfg, state);
      } catch (e) {
        console.error("tick failed:", e.message);
      }
    }, (cfg.intervalSec ?? 10) * 1000);
  } else {
    process.exit(0);
  }
}

if (process.argv[1]?.endsWith("jaga.mjs")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
