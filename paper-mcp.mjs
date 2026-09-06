// Paper-trading MCP server: REAL Binance market, simulated wallet.
//   prices : Binance WebSocket miniTicker stream (data-stream.binance.vision), REST bootstrap
//   fills  : walk the live order book (/api/v3/depth) → real slippage, Binance taker fee
//   limits : real exchange filters (min notional) from /api/v3/exchangeInfo
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
const REST = "https://data-api.binance.vision";
const WS = "wss://data-stream.binance.vision/stream?streams=";
const QUOTE = "USDC";
const SYMBOLS = ["BTCUSDC", "ETHUSDC", "BNBUSDC", "SOLUSDC"];
const TAKER_FEE = 0.001; // Binance spot default tier, 0.1%

const account = {
  balances: [
    { asset: "USDC", free: 600 },
    { asset: "BTC", free: 0.004 },
    { asset: "ETH", free: 0.1 },
    { asset: "SOL", free: 1.5 },
  ],
};
const prices = {}; // symbol -> last price, kept live by the WebSocket
const filters = {}; // symbol -> { minNotional }
let priceSource = "rest";
const orders = [];

const get = async (path) => {
  const res = await fetch(REST + path, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`binance.vision ${res.status} ${path}`);
  return res.json();
};

async function bootstrap() {
  const list = await get("/api/v3/ticker/price?symbols=" + encodeURIComponent(JSON.stringify(SYMBOLS)));
  for (const { symbol, price } of list) prices[symbol] = Number(price);
  const info = await get("/api/v3/exchangeInfo?symbols=" + encodeURIComponent(JSON.stringify(SYMBOLS)));
  for (const s of info.symbols) {
    const f = s.filters.find((x) => x.filterType === "NOTIONAL");
    filters[s.symbol] = { minNotional: Number(f?.minNotional ?? 5) };
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
  if (priceSource === "websocket") return;
  const list = await get("/api/v3/ticker/price?symbols=" + encodeURIComponent(JSON.stringify(SYMBOLS)));
  for (const { symbol, price } of list) prices[symbol] = Number(price);
}

// walk the real book: a market order eats levels until the quote amount is spent
async function fillFromBook(symbol, side, quoteQty) {
  const book = await get(`/api/v3/depth?symbol=${symbol}&limit=100`);
  const levels = side === "BUY" ? book.asks : book.bids;
  let remaining = quoteQty,
    qty = 0,
    cost = 0;
  for (const [p, q] of levels) {
    const price = Number(p),
      avail = Number(q);
    const take = Math.min(avail, remaining / price);
    qty += take;
    cost += take * price;
    remaining -= take * price;
    if (remaining <= 1e-9) break;
  }
  if (qty <= 0) throw new Error("empty book");
  return { qty, cost, avgPrice: cost / qty, levels: levels.length, top: Number(levels[0][0]) };
}

function bal(asset) {
  let b = account.balances.find((x) => x.asset === asset);
  if (!b) account.balances.push((b = { asset, free: 0 }));
  return b;
}

async function placeOrder({ symbol, side, quoteOrderQty }) {
  const asset = symbol.slice(0, -QUOTE.length);
  if (!SYMBOLS.includes(symbol)) return { status: "REJECTED", reason: `unknown symbol ${symbol}` };
  const min = filters[symbol]?.minNotional ?? 5;
  if (quoteOrderQty < min) return { status: "REJECTED", reason: `below exchange min notional ${min} ${QUOTE}` };
  const usdc = bal(QUOTE),
    a = bal(asset);
  if (side === "BUY") {
    if (usdc.free < quoteOrderQty) return { status: "REJECTED", reason: "insufficient USDC" };
    const f = await fillFromBook(symbol, "BUY", quoteOrderQty);
    const fee = f.qty * TAKER_FEE;
    usdc.free -= f.cost;
    a.free += f.qty - fee;
    const o = { status: "FILLED", symbol, side, executedQty: f.qty - fee, cummulativeQuoteQty: f.cost, fillPrice: f.avgPrice, fee, feeAsset: asset, slippagePct: ((f.avgPrice - f.top) / f.top) * 100, priceSource };
    orders.push(o);
    return o;
  }
  if (side === "SELL") {
    const want = Math.min(a.free, quoteOrderQty / prices[symbol]);
    if (want <= 0) return { status: "REJECTED", reason: `no ${asset} to sell` };
    const f = await fillFromBook(symbol, "SELL", want * prices[symbol]);
    const qty = Math.min(want, f.qty);
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
    return json({ ...prices, _source: priceSource });
  });
  server.tool(
    "place_order",
    "Market order filled against the live Binance order book, taker fee applied, exchange min-notional enforced",
    { symbol: z.string(), side: z.enum(["BUY", "SELL"]), type: z.string().optional(), quoteOrderQty: z.number().positive() },
    async (o) => {
      const r = await placeOrder(o);
      console.error(`${r.status === "FILLED" ? "📗" : "📕"} ${o.side} ${o.symbol} $${o.quoteOrderQty.toFixed(2)} → ${r.status}${r.fillPrice ? ` @ ${r.fillPrice.toFixed(2)} (slip ${r.slippagePct.toFixed(3)}%, fee ${r.fee.toFixed(6)} ${r.feeAsset})` : ` (${r.reason})`}`);
      return json(r);
    }
  );
  server.tool("get_orders", "Every order filled on this paper wallet", async () => json(orders));
  return server;
}

await bootstrap();
streamPrices();

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
