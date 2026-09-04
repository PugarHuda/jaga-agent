// Mock Binance MCP server (stdio) for demos & tests — no keys, no real money.
// Prices random-walk with a bearish bias so Jaga's rules visibly trigger.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const account = {
  balances: [
    { asset: "USDC", free: 400 },
    { asset: "BTC", free: 0.005 },
    { asset: "ETH", free: 0.12 },
  ],
};
const prices = { BTCUSDC: 100000, ETHUSDC: 4000 };

// bearish drift: -1.5% ± 1% per call, so stop-loss trips within ~6 ticks
function drift() {
  for (const k of Object.keys(prices)) {
    prices[k] *= 1 - 0.015 + (Math.random() - 0.5) * 0.02;
  }
}

const server = new McpServer({ name: "binance-mock", version: "1.0.0" });
const json = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });

server.tool("get_account", "Subaccount balances", async () => json(account));
server.tool("get_prices", "Spot prices for all pairs", async () => {
  drift();
  return json(prices);
});
server.tool(
  "place_order",
  "Place a spot order",
  { symbol: z.string(), side: z.string(), type: z.string(), quoteOrderQty: z.number() },
  async ({ symbol, side, quoteOrderQty }) => {
    const asset = symbol.replace("USDC", "");
    const price = prices[symbol];
    const bal = account.balances.find((b) => b.asset === asset);
    const usdc = account.balances.find((b) => b.asset === "USDC");
    if (side === "SELL" && bal && price) {
      const qty = Math.min(bal.free, quoteOrderQty / price);
      bal.free -= qty;
      usdc.free += qty * price;
      return json({ status: "FILLED", symbol, side, executedQty: qty });
    }
    return json({ status: "REJECTED", reason: "unsupported in mock" });
  }
);

await server.connect(new StdioServerTransport());
