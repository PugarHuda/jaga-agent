// Paper-trading MCP server: REAL Binance market, simulated wallet.
//   prices : Binance WebSocket miniTicker stream (data-stream.binance.vision), REST bootstrap
//   fills  : walk the live order book (/api/v3/depth) → real slippage, Binance taker fee
//   limits : real exchange filters (min notional) from /api/v3/exchangeInfo
// Replay mode: --replay 2024-08-04T20:00:00Z [--step 15] [--hours 12] steps through
// REAL historical 1-minute candles (/api/v3/klines) instead of the live stream —
// a real crash, deterministic, no synthetic market anywhere.
// No API keys, no real money, real market. Two transports:
//   node paper-mcp.mjs              stdio (one client)
//   node paper-mcp.mjs --http 7788  Streamable HTTP — many clients share ONE wallet,
//                                   which is how a rogue agent and Jaga end up on the
//                                   same subaccount (see rogue-agent.mjs, paper.mjs)
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const args = process.argv.slice(2);
const HTTP_PORT = args.includes("--http") ? Number(args[args.indexOf("--http") + 1] || 7788) : 0;
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const REPLAY_FROM = opt("--replay", null); // ISO timestamp → historical replay
const REPLAY_STEP = Number(opt("--step", 15)); // minutes advanced per get_prices call
const REPLAY_HOURS = Number(opt("--hours", 12));
const REST = "https://data-api.binance.vision";
const WS = "wss://data-stream.binance.vision/stream?streams=";
const QUOTE = "USDC";
const SYMBOLS = ["BTCUSDC", "ETHUSDC", "BNBUSDC", "SOLUSDC", "USDCUSDT"]; // USDCUSDT: lets a USDT balance be valued through a bridge
const TAKER_FEE = 0.001; // Binance spot default tier, 0.1%

const account = {
  balances: [
    { asset: "USDC", free: 600 },
    { asset: "BTC", free: 0.004 },
    { asset: "ETH", free: 0.1 },
    { asset: "SOL", free: 1.5 },
    { asset: "USDT", free: 40 }, // no USDTUSDC pair on Binance → Jaga must value it via USDCUSDT
  ],
};
const prices = {}; // symbol -> last price, kept live by the WebSocket
const filters = {}; // symbol -> { minNotional, stepSize, minQty }
let exchangeInfo = { symbols: [] }; // raw Binance filters, served verbatim by get_symbol_info
let priceSource = "rest";
let lastWsAt = 0;
const replay = { candles: {}, i: 0, n: 0, t: null }; // symbol -> [{t, close}], cursor
const orders = [];

const get = async (path, retried = false) => {
  const res = await fetch(REST + path, { signal: AbortSignal.timeout(8000) });
  if ((res.status === 429 || res.status === 418) && !retried) {
    const wait = Math.min(30, Number(res.headers.get("retry-after")) || 5);
    console.error(`⏳ binance.vision ${res.status} — backing off ${wait}s`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return get(path, true);
  }
  if (!res.ok) throw new Error(`binance.vision ${res.status} ${path}`);
  return res.json();
};

// Historical candles for every symbol, one request each (≤1000 × 1m), aligned by index.
async function loadReplay() {
  const start = Date.parse(REPLAY_FROM);
  if (!Number.isFinite(start)) throw new Error(`--replay needs an ISO timestamp, got ${REPLAY_FROM}`);
  const end = start + REPLAY_HOURS * 3600e3;
  for (const sym of SYMBOLS) {
    const k = await get(`/api/v3/klines?symbol=${sym}&interval=1m&startTime=${start}&endTime=${end}&limit=1000`);
    replay.candles[sym] = k.map((c) => ({ t: c[0], close: Number(c[4]) }));
  }
  replay.n = Math.min(...Object.values(replay.candles).map((c) => c.length));
  if (!replay.n) throw new Error("no candles in the replay window");
  seekReplay(0);
  console.error(`⏪ replaying ${replay.n} minutes of real Binance history from ${new Date(start).toISOString()} (${REPLAY_STEP} min per tick)`);
}
function seekReplay(i) {
  replay.i = Math.min(i, replay.n - 1);
  for (const sym of SYMBOLS) prices[sym] = replay.candles[sym][replay.i].close;
  replay.t = new Date(replay.candles[SYMBOLS[0]][replay.i].t).toISOString();
  priceSource = "replay";
}

async function bootstrap() {
  const list = await get("/api/v3/ticker/price?symbols=" + encodeURIComponent(JSON.stringify(SYMBOLS)));
  for (const { symbol, price } of list) prices[symbol] = Number(price);
  const info = await get("/api/v3/exchangeInfo?symbols=" + encodeURIComponent(JSON.stringify(SYMBOLS)));
  exchangeInfo = { symbols: info.symbols.map((s) => ({ symbol: s.symbol, baseAsset: s.baseAsset, quoteAsset: s.quoteAsset, filters: s.filters })) };
  for (const s of info.symbols) {
    const n = s.filters.find((x) => x.filterType === "NOTIONAL");
    const l = s.filters.find((x) => x.filterType === "LOT_SIZE");
    filters[s.symbol] = { minNotional: Number(n?.minNotional ?? 5), stepSize: Number(l?.stepSize ?? 0), minQty: Number(l?.minQty ?? 0) };
  }
}

// live prices over WebSocket; if the socket dies we fall back to REST polling until it's back
function streamPrices() {
  let ws;
  const open = () => {
    ws = new WebSocket(WS + SYMBOLS.map((s) => s.toLowerCase() + "@miniTicker").join("/"));
    ws.onmessage = (m) => {
      const { data } = JSON.parse(m.data);
      if (data?.s && data?.c) {
        prices[data.s] = Number(data.c);
        priceSource = "websocket";
        lastWsAt = Date.now();
      }
    };
    ws.onclose = ws.onerror = () => {
      priceSource = "rest";
      setTimeout(open, 3000);
    };
  };
  open();
}

async function refreshIfStale() {
  if (REPLAY_FROM) return seekReplay(replay.i + REPLAY_STEP); // advance history; holds at the last candle
  if (priceSource === "websocket" && Date.now() - lastWsAt > 15000) priceSource = "rest (websocket stale)";
  if (priceSource === "websocket") return;
  const list = await get("/api/v3/ticker/price?symbols=" + encodeURIComponent(JSON.stringify(SYMBOLS)));
  for (const { symbol, price } of list) prices[symbol] = Number(price);
}

// walk the real book: a market order eats levels until the quote amount is spent
async function fillFromBook(symbol, side, { quote = Infinity, base = Infinity }) {
  if (REPLAY_FROM) {
    const price = prices[symbol];
    const qty = Math.min(quote / price, base);
    return { qty, cost: qty * price, avgPrice: price, levels: 0, top: price };
  }
  const book = await get(`/api/v3/depth?symbol=${symbol}&limit=100`);
  const levels = side === "BUY" ? book.asks : book.bids;
  let remQ = quote,
    remB = base,
    qty = 0,
    cost = 0;
  for (const [p, q] of levels) {
    const price = Number(p),
      avail = Number(q);
    const take = Math.min(avail, remQ / price, remB);
    qty += take;
    cost += take * price;
    remQ -= take * price;
    remB -= take;
    if (remQ <= 1e-9 || remB <= 1e-12) break;
  }
  if (qty <= 0) throw new Error("empty book");
  return { qty, cost, avgPrice: cost / qty, levels: levels.length, top: Number(levels[0][0]) };
}

function bal(asset) {
  let b = account.balances.find((x) => x.asset === asset);
  if (!b) account.balances.push((b = { asset, free: 0 }));
  return b;
}

async function placeOrder({ symbol, side, quoteOrderQty, quantity }) {
  const asset = symbol.slice(0, -QUOTE.length);
  if (!SYMBOLS.includes(symbol)) return { status: "REJECTED", reason: `unknown symbol ${symbol}` };
  const f = filters[symbol] ?? { minNotional: 5, stepSize: 0, minQty: 0 };
  if (quantity !== undefined) {
    // Binance's LOT_SIZE filter: quantity must be a multiple of stepSize and >= minQty
    const steps = f.stepSize ? quantity / f.stepSize : 0;
    if (quantity < f.minQty || (f.stepSize && Math.abs(steps - Math.round(steps)) > 1e-6)) return { status: "REJECTED", reason: `Filter failure: LOT_SIZE (step ${f.stepSize}, min ${f.minQty})` };
    quoteOrderQty = quantity * prices[symbol];
  }
  if (!(quoteOrderQty > 0)) return { status: "REJECTED", reason: "quoteOrderQty or quantity required" };
  const min = f.minNotional;
  if (quoteOrderQty < min) return { status: "REJECTED", reason: `below exchange min notional ${min} ${QUOTE}` };
  const usdc = bal(QUOTE),
    a = bal(asset);
  if (side === "BUY") {
    if (usdc.free < quoteOrderQty) return { status: "REJECTED", reason: "insufficient USDC" };
    const f = await fillFromBook(symbol, "BUY", quantity !== undefined ? { base: quantity } : { quote: quoteOrderQty });
    const fee = f.qty * TAKER_FEE;
    usdc.free -= f.cost;
    a.free += f.qty - fee;
    const o = { status: "FILLED", symbol, side, executedQty: f.qty - fee, cummulativeQuoteQty: f.cost, fillPrice: f.avgPrice, fee, feeAsset: asset, slippagePct: ((f.avgPrice - f.top) / f.top) * 100, priceSource };
    orders.push(o);
    return o;
  }
  if (side === "SELL") {
    const want = quantity !== undefined ? quantity : Math.min(a.free, quoteOrderQty / prices[symbol]);
    if (quantity !== undefined && quantity > a.free + 1e-12) return { status: "REJECTED", reason: `insufficient ${asset} (have ${a.free})` };
    if (want <= 0) return { status: "REJECTED", reason: `no ${asset} to sell` };
    const f = await fillFromBook(symbol, "SELL", { base: want });
    const qty = f.qty; // exactly what was asked (book is 100 levels deep; paper sizes never exhaust it)
    const proceeds = qty * f.avgPrice;
    const fee = proceeds * TAKER_FEE;
    a.free -= qty;
    usdc.free += proceeds - fee;
    const o = { status: "FILLED", symbol, side, executedQty: qty, cummulativeQuoteQty: proceeds - fee, fillPrice: f.avgPrice, fee, feeAsset: QUOTE, slippagePct: ((f.top - f.avgPrice) / f.top) * 100, priceSource };
    orders.push(o);
    return o;
  }
  return { status: "REJECTED", reason: "side must be BUY or SELL" };
}

function buildServer() {
  const server = new McpServer({ name: "binance-paper", version: "2.0.0" });
  // structuredContent must be an object per MCP spec — arrays get wrapped
  const json = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }], structuredContent: Array.isArray(obj) ? { items: obj } : obj });
  server.tool("get_account", "Paper subaccount balances (shared by every connected agent)", async () => json(account));
  server.tool("get_prices", `LIVE Binance spot prices via ${priceSource} (data-stream/data-api.binance.vision)`, async () => {
    await refreshIfStale();
    return json({ ...prices, _source: priceSource, ...(REPLAY_FROM ? { _replayTime: replay.t, _replayMinute: replay.i, _replayTotal: replay.n } : {}) });
  });
  server.tool(
    "place_order",
    "Market order filled against the live Binance order book, taker fee applied, exchange min-notional enforced",
    { symbol: z.string(), side: z.enum(["BUY", "SELL"]), type: z.string().optional(), quoteOrderQty: z.number().positive().optional(), quantity: z.number().positive().optional() },
    async (o) => {
      const r = await placeOrder(o);
      console.error(`${r.status === "FILLED" ? "📗" : "📕"} ${o.side} ${o.symbol} ${o.quantity !== undefined ? `qty ${o.quantity}` : `${o.quoteOrderQty.toFixed(2)}`} → ${r.status}${r.fillPrice ? ` @ ${r.fillPrice.toFixed(2)} (slip ${r.slippagePct.toFixed(3)}%, fee ${r.fee.toFixed(6)} ${r.feeAsset})` : ` (${r.reason})`}`);
      return json(r);
    }
  );
  server.tool("get_orders", "Every order filled on this paper wallet", async () => json(orders));
  server.tool("get_symbol_info", "Real Binance exchange filters (LOT_SIZE, NOTIONAL…) for the paper symbols, verbatim from /api/v3/exchangeInfo", async () => json(exchangeInfo));
  return server;
}

await bootstrap();
if (REPLAY_FROM) await loadReplay();
else streamPrices();

if (HTTP_PORT) {
  const srv = http.createServer(async (req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); // stateless; wallet state lives in this process
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  srv.listen(HTTP_PORT, "127.0.0.1", () => console.error(`📈 paper MCP (HTTP) → http://127.0.0.1:${HTTP_PORT}/mcp  prices=${priceSource}`));
} else {
  await buildServer().connect(new StdioServerTransport());
}
