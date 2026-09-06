// Integration checks: response-shape normalizers, config validation, audit hash
// chain, and the paper MCP server over Streamable HTTP against the live Binance
// book (needs internet). Run: npm test
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { toolResult, parseBalances, parsePrices, validateConfig } from "./shapes.mjs";
import { verifyAudit } from "./audit-verify.mjs";

let checks = 0;
const ok = (c, m) => {
  assert.ok(c, m);
  checks++;
};
const eq = (a, b, m) => {
  assert.deepStrictEqual(a, b, m);
  checks++;
};

// --- shapes: every balance/price shape seen across Binance MCP servers ------
eq(parseBalances({ balances: [{ asset: "BTC", free: "0.5", locked: "0" }] }), [{ asset: "BTC", free: 0.5 }], "official REST shape");
eq(parseBalances([{ coin: "eth", available: 2 }]), [{ asset: "ETH", free: 2 }], "array + coin/available");
eq(parseBalances({ data: { balances: [{ asset: "SOL", balance: "3" }] } }), [{ asset: "SOL", free: 3 }], "wrapped in data");
eq(parseBalances({ BTC: 0.1, ETH: "1.5" }), [{ asset: "BTC", free: 0.1 }, { asset: "ETH", free: 1.5 }], "asset→amount map");
eq(parseBalances(null), [], "garbage in → empty");
eq(parsePrices({ BTCUSDC: 100, ETHUSDC: "2500" }), { BTCUSDC: 100, ETHUSDC: 2500 }, "symbol→price map");
eq(parsePrices([{ symbol: "BTC/USDC", price: "100" }]), { BTCUSDC: 100 }, "ticker array with slash");
eq(parsePrices({ data: [{ symbol: "ETHUSDC", lastPrice: 2500 }] }), { ETHUSDC: 2500 }, "24h ticker under data");
eq(parsePrices({ BTCUSDC: { price: 100 } }), { BTCUSDC: 100 }, "nested price objects");
eq(toolResult({ structuredContent: { a: 1 }, content: [] }), { a: 1 }, "structuredContent preferred");
eq(toolResult({ content: [{ type: "text", text: '{"b":2}' }] }), { b: 2 }, "text JSON fallback");
assert.throws(() => toolResult({ isError: true, content: [{ type: "text", text: "boom" }] }), /MCP tool error: boom/);
checks++;
assert.throws(() => toolResult({ content: [{ type: "text", text: "not json" }] }), /non-JSON/);
checks++;

// --- config validation: a missing rule must fail loud, not silently never fire
const good = JSON.parse(fs.readFileSync("config.demo.json", "utf8"));
eq(validateConfig(good), [], "demo config valid");
const bad = structuredClone(good);
delete bad.rules.stopLossPct;
bad.rules.mode = "yolo";
bad.rules.volatility.window = 1;
const errs = validateConfig(bad);
ok(errs.some((e) => e.includes("stopLossPct")), "missing rule reported");
ok(errs.some((e) => e.includes("mode")), "bad mode reported");
ok(errs.some((e) => e.includes("window")), "bad window reported");
ok(validateConfig({}).length >= 5, "empty config is loudly invalid");

// --- audit hash chain: tampering is detected at the exact line ---------------
const tmp = path.join(os.tmpdir(), `jaga-audit-${process.pid}.jsonl`);
let prev = "";
const lines = [];
for (const type of ["tick", "violation", "action"]) {
  const rec = { ts: "t", type, prev };
  rec.hash = createHash("sha256").update(JSON.stringify(rec)).digest("hex");
  prev = rec.hash;
  lines.push(JSON.stringify(rec));
}
fs.writeFileSync(tmp, lines.join("\n") + "\n");
ok(verifyAudit(tmp).ok, "intact chain verifies");
const tampered = lines.slice();
tampered[1] = tampered[1].replace('"violation"', '"nothing"');
fs.writeFileSync(tmp, tampered.join("\n") + "\n");
let v = verifyAudit(tmp);
ok(!v.ok && v.line === 2, "edited entry caught at its line");
fs.writeFileSync(tmp, [lines[0], lines[2]].join("\n") + "\n");
v = verifyAudit(tmp);
ok(!v.ok && v.line === 2, "deleted entry breaks the link");
fs.unlinkSync(tmp);

// --- paper MCP over HTTP: real book, real fees, real filters ------------------
const PORT = 7790;
const srv = spawn(process.execPath, ["paper-mcp.mjs", "--http", String(PORT)], { stdio: ["ignore", "ignore", "pipe"] });
let stderr = "";
srv.stderr.on("data", (d) => (stderr += d));
try {
  const t0 = Date.now();
  while (!/paper MCP/.test(stderr)) {
    if (Date.now() - t0 > 20000) throw new Error("paper-mcp did not start: " + stderr);
    await new Promise((r) => setTimeout(r, 200));
  }
  const url = new URL(`http://127.0.0.1:${PORT}/mcp`);
  const a = new Client({ name: "agent-a", version: "1" });
  const b = new Client({ name: "agent-b", version: "1" });
  await a.connect(new StreamableHTTPClientTransport(url));
  await b.connect(new StreamableHTTPClientTransport(url));
  const names = (await a.listTools()).tools.map((t) => t.name);
  ok(["get_account", "get_prices", "place_order"].every((n) => names.includes(n)), "paper server exposes the tool trio");
  const prices = parsePrices(toolResult(await a.callTool({ name: "get_prices", arguments: {} })));
  ok(prices.ETHUSDC > 100 && prices.BTCUSDC > 1000, "live prices look like prices");
  const before = parseBalances(toolResult(await a.callTool({ name: "get_account", arguments: {} })));
  const usdc0 = before.find((x) => x.asset === "USDC").free;
  const buy = toolResult(await a.callTool({ name: "place_order", arguments: { symbol: "ETHUSDC", side: "BUY", type: "MARKET", quoteOrderQty: 100 } }));
  eq(buy.status, "FILLED", "BUY fills against the live book");
  ok(buy.fee > 0 && buy.feeAsset === "ETH" && Math.abs(buy.cummulativeQuoteQty - 100) < 0.01, "taker fee charged in base, quote spent");
  ok(buy.slippagePct >= 0 && buy.slippagePct < 1, "slippage computed from the book");
  const afterBuy = parseBalances(toolResult(await b.callTool({ name: "get_account", arguments: {} })));
  ok(Math.abs(afterBuy.find((x) => x.asset === "USDC").free - (usdc0 - 100)) < 0.01, "second client sees the SAME wallet (shared subaccount)");
  const sell = toolResult(await b.callTool({ name: "place_order", arguments: { symbol: "ETHUSDC", side: "SELL", type: "MARKET", quoteOrderQty: 50 } }));
  eq(sell.status, "FILLED", "SELL fills");
  ok(sell.feeAsset === "USDC" && sell.fee > 0, "SELL fee charged in quote");
  const tiny = toolResult(await a.callTool({ name: "place_order", arguments: { symbol: "ETHUSDC", side: "SELL", type: "MARKET", quoteOrderQty: 1 } }));
  ok(tiny.status === "REJECTED" && /min notional/.test(tiny.reason), "exchange min-notional filter enforced");
  const unknown = toolResult(await a.callTool({ name: "place_order", arguments: { symbol: "DOGEUSDC", side: "BUY", type: "MARKET", quoteOrderQty: 20 } }));
  ok(unknown.status === "REJECTED", "unknown symbol rejected");
  await a.close();
  await b.close();
} finally {
  srv.kill();
}

console.log(`✅ all ${checks} integration checks passed`);
