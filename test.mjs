// Self-check for Jaga's pure risk engine. Run: npm test
import assert from "node:assert";
import { evaluate } from "./jaga.mjs";

const rules = { quote: "USDC", maxPositionPct: 40, maxDrawdownPct: 10, stopLossPct: 5, minTradeUsd: 10, mode: "propose" };

// 1. Healthy portfolio → no violations, entries recorded, peak tracked
let snap = { positions: [{ asset: "BTC", qty: 0.001, price: 100000, usd: 100 }], quote: "USDC", quoteFree: 200, total: 300 };
let r = evaluate(snap, rules, { peak: 0, entries: {} });
assert.strictEqual(r.violations.length, 0);
assert.strictEqual(r.state.entries.BTC, 100000);
assert.strictEqual(r.state.peak, 300);

// 2. Price drops 6% from entry → stop-loss fires, sells whole position
snap = { positions: [{ asset: "BTC", qty: 0.001, price: 94000, usd: 94 }], quote: "USDC", quoteFree: 200, total: 294 };
r = evaluate(snap, rules, r.state);
assert.ok(r.violations.some((v) => v.rule === "stop-loss"));
assert.deepStrictEqual(r.actions, [{ side: "SELL", symbol: "BTCUSDC", usd: 94 }]);

// 3. Concentration: one asset at 80% of portfolio → sell down to 40%
snap = { positions: [{ asset: "ETH", qty: 0.2, price: 4000, usd: 800 }], quote: "USDC", quoteFree: 200, total: 1000 };
r = evaluate(snap, rules, { peak: 0, entries: {} });
assert.ok(r.violations.some((v) => v.rule === "max-position"));
assert.strictEqual(r.actions[0].usd, 400); // 800 - 40% of 1000

// 4. Drawdown 15% from peak → de-risk everything (supersedes partial sells)
snap = { positions: [{ asset: "ETH", qty: 0.1, price: 4000, usd: 400 }], quote: "USDC", quoteFree: 450, total: 850 };
r = evaluate(snap, rules, { peak: 1000, entries: { ETH: 4000 } });
assert.ok(r.violations.some((v) => v.rule === "max-drawdown"));
assert.strictEqual(r.actions[0].usd, 400);

// 5. Dust below minTradeUsd is ignored
snap = { positions: [{ asset: "DOGE", qty: 10, price: 0.5, usd: 5 }], quote: "USDC", quoteFree: 1, total: 6 };
r = evaluate(snap, rules, { peak: 0, entries: { DOGE: 1 } }); // -50% but only $5
assert.strictEqual(r.actions.length, 0);

console.log("✅ all 5 risk-engine checks passed");
