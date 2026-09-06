// Backtest: run Jaga through a real historical window and report what it did
// versus doing nothing. Same code path as production — paper server in replay,
// the rogue agent, Jaga — just with a fast clock.
//
//   npm run backtest                       Aug 4-5 2024 crash, 12h, 15-minute steps
//   node backtest.mjs --replay 2025-02-02T20:00:00Z --hours 24 --step 30 [--no-rogue]
//
// Prints a report and writes backtest-report.json (also consumed by CI).
import fs from "node:fs";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { toolResult, parseBalances, parsePrices, valueSnapshot } from "./shapes.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const FROM = opt("--replay", "2024-08-04T20:00:00Z");
const HOURS = opt("--hours", "12");
const STEP = opt("--step", "15");
const CONFIG = opt("--config", "config.demo.json");
const MCP_PORT = 7795, DASH_PORT = 7796;
const TICK = 1; // real seconds per step

const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
cfg.mcp = { url: `http://127.0.0.1:${MCP_PORT}/mcp` };
cfg.intervalSec = TICK;
cfg.dashboard = { port: DASH_PORT };
cfg.advisor = { everyTicks: 0 };
cfg.rules.mode = "execute";
fs.mkdirSync(".backtest", { recursive: true });
fs.writeFileSync(".backtest/config.json", JSON.stringify(cfg));
for (const f of [".backtest/state.json", ".backtest/audit.jsonl"]) fs.rmSync(f, { force: true });

const kids = [];
const run = (a, quiet) => {
  const p = spawn(process.execPath, a, { stdio: ["ignore", quiet ? "ignore" : "inherit", "pipe"], env: { ...process.env, OPENROUTER_API_KEY: "", LLM_API_KEY: "", VENICE_API_KEY: "" } });
  kids.push(p);
  return p;
};
const stopAll = () => kids.forEach((k) => k.kill());
process.on("SIGINT", () => (stopAll(), process.exit(1)));

try {
  const paper = run(["paper-mcp.mjs", "--http", String(MCP_PORT), "--replay", FROM, "--hours", HOURS, "--step", STEP, "--tick", String(TICK)], true);
  let perr = "";
  paper.stderr.on("data", (d) => (perr += d));
  for (let i = 0; i < 300 && !/replaying/.test(perr); i++) await new Promise((r) => setTimeout(r, 200));
  if (!/replaying/.test(perr)) throw new Error("paper server failed: " + perr);

  const mcp = new Client({ name: "backtest", version: "1" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`)));
  const wallet0 = parseBalances(toolResult(await mcp.callTool({ name: "get_account", arguments: {} })));
  const prices0 = parsePrices(toolResult(await mcp.callTool({ name: "get_prices", arguments: {} })));
  const start = valueSnapshot(wallet0, prices0, cfg.rules.quote);

  if (!args.includes("--no-rogue")) run(["rogue-agent.mjs", "--url", `http://127.0.0.1:${MCP_PORT}/mcp`, "--every", "6"], true);
  const jaga = run(["jaga.mjs", "--config", ".backtest/config.json", "--state", ".backtest/state.json", "--audit", ".backtest/audit.jsonl"], true);
  let jerr = "";
  jaga.stderr.on("data", (d) => (jerr += d));

  // run until the replay reaches its last candle
  let p;
  do {
    await new Promise((r) => setTimeout(r, 1000));
    p = toolResult(await mcp.callTool({ name: "get_prices", arguments: {} }));
    process.stdout.write(`\r⏪ ${p._replayTime}  (${p._replayMinute}/${p._replayTotal - 1} min)   `);
  } while (p._replayMinute < p._replayTotal - 1);
  await new Promise((r) => setTimeout(r, (TICK + 1) * 1000)); // one more Jaga tick at the final prices
  console.log();

  const walletEnd = parseBalances(toolResult(await mcp.callTool({ name: "get_account", arguments: {} })));
  const pricesEnd = parsePrices(toolResult(await mcp.callTool({ name: "get_prices", arguments: {} })));
  const end = valueSnapshot(walletEnd, pricesEnd, cfg.rules.quote);
  const hold = valueSnapshot(wallet0, pricesEnd, cfg.rules.quote); // buy-and-hold: the starting wallet at the ending prices
  const orders = toolResult(await mcp.callTool({ name: "get_orders", arguments: {} })).items ?? [];
  const audit = fs.readFileSync(".backtest/audit.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const byRule = {};
  for (const e of audit) if (e.type === "violation") byRule[e.rule] = (byRule[e.rule] ?? 0) + 1;
  const jagaSells = orders.filter((o) => o.side === "SELL" && o.status === "FILLED");
  const rogueBuys = orders.filter((o) => o.side === "BUY" && o.status === "FILLED");
  const minTotal = Math.min(...audit.filter((e) => e.type === "tick").map((e) => e.total));

  const report = {
    window: { from: FROM, hours: Number(HOURS), stepMinutes: Number(STEP) },
    market: Object.fromEntries(Object.keys(prices0).filter((k) => k !== "_source" && !k.startsWith("_")).map((k) => [k, { start: prices0[k], end: pricesEnd[k], changePct: ((pricesEnd[k] - prices0[k]) / prices0[k]) * 100 }])),
    start: { total: start.total, positions: start.positions.map((x) => ({ asset: x.asset, usd: x.usd })) },
    buyAndHold: { total: hold.total, returnPct: ((hold.total - start.total) / start.total) * 100 },
    jaga: { total: end.total, returnPct: ((end.total - start.total) / start.total) * 100, worstTotal: minTotal, maxDrawdownPct: ((start.total - minTotal) / start.total) * 100, sells: jagaSells.length, feesPaid: jagaSells.reduce((t, o) => t + o.fee, 0), violationsByRule: byRule },
    rogue: { buys: rogueBuys.length, usdPumped: rogueBuys.reduce((t, o) => t + o.cummulativeQuoteQty, 0) },
    advantageUsd: end.total - hold.total,
    advantagePct: ((end.total - hold.total) / hold.total) * 100,
  };
  fs.writeFileSync("backtest-report.json", JSON.stringify(report, null, 2));

  const pct = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
  console.log(`\n🛡️  Jaga backtest — ${FROM} +${HOURS}h (real Binance history, ${STEP}-minute steps)\n`);
  for (const [k, m] of Object.entries(report.market)) console.log(`   ${k.padEnd(9)} ${m.start.toFixed(2).padStart(10)} → ${m.end.toFixed(2).padStart(10)}   ${pct(m.changePct)}`);
  console.log(`\n   start portfolio      ${start.total.toFixed(2)} ${cfg.rules.quote}`);
  console.log(`   buy-and-hold ends    ${hold.total.toFixed(2)} (${pct(report.buyAndHold.returnPct)})`);
  console.log(`   with Jaga ends       ${end.total.toFixed(2)} (${pct(report.jaga.returnPct)})  worst tick ${minTotal.toFixed(2)} (max DD ${report.jaga.maxDrawdownPct.toFixed(2)}%)`);
  console.log(`   rogue agent          ${rogueBuys.length} buys, $${report.rogue.usdPumped.toFixed(2)} pumped into ETH`);
  console.log(`   Jaga                 ${jagaSells.length} sells, fees ${report.jaga.feesPaid.toFixed(4)}, rules: ${Object.entries(byRule).map(([r, n]) => `${r}×${n}`).join(", ") || "none"}`);
  console.log(`\n   ⇒ Jaga vs holding:   ${report.advantageUsd >= 0 ? "+" : ""}${report.advantageUsd.toFixed(2)} ${cfg.rules.quote} (${pct(report.advantagePct)})\n`);
  await mcp.close();
} finally {
  stopAll();
}
