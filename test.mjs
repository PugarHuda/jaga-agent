// Self-checks for Jaga's pure risk engine (engine.mjs). Run: npm test
import assert from "node:assert";
import { evaluate, freshState } from "./engine.mjs";

const rules = {
  quote: "USDC",
  maxPositionPct: 40,
  maxDrawdownPct: 10,
  stopLossPct: 5,
  trailingStopPct: 4,
  takeProfitPct: 10,
  minTradeUsd: 10,
  volatility: { window: 3, dropPct: 6 },
  mode: "propose",
};
const snap = (positions, quoteFree) => ({
  positions,
  quote: "USDC",
  quoteFree,
  total: quoteFree + positions.reduce((s, p) => s + p.usd, 0),
});
const pos = (asset, price, usd) => ({ asset, qty: usd / price, price, usd });
let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks++;
};

// 1. Healthy portfolio → no violations, book-keeping correct
let r = evaluate(snap([pos("BTC", 100000, 100)], 200), rules, freshState());
ok(r.violations.length === 0, "healthy: no violations");
ok(r.state.entries.BTC.entry === 100000 && r.state.peak === 300, "healthy: entry+peak recorded");

// 2. Stop-loss: -6% from entry → full liquidation, book reset
r = evaluate(snap([pos("BTC", 94000, 94)], 200), rules, r.state);
ok(r.violations.some((v) => v.rule === "stop-loss"), "stop-loss fires at -6%");
ok(r.actions[0].full && r.actions[0].symbol === "BTCUSDC", "stop-loss sells everything");
ok(!r.state.entries.BTC, "stop-loss resets the book");

// 3. Trailing stop: price ran +8% (below TP) then fell 5% off the high → lock gains
let st = freshState();
r = evaluate(snap([pos("ETH", 4000, 400)], 600), rules, st); // entry 4000
r = evaluate(snap([pos("ETH", 4320, 432)], 600), rules, r.state); // high 4320 (+8%)
r = evaluate(snap([pos("ETH", 4104, 410.4)], 600), rules, r.state); // -5% from high, +2.6% from entry
ok(r.violations.some((v) => v.rule === "trailing-stop"), "trailing stop fires 5% off the high");
ok(r.actions[0].full, "trailing stop liquidates");

// 4. Take-profit: +12% from entry → realize
st = freshState();
r = evaluate(snap([pos("BTC", 100000, 100)], 900), rules, st);
r = evaluate(snap([pos("BTC", 112000, 112)], 900), rules, r.state);
ok(r.violations.some((v) => v.rule === "take-profit"), "take-profit fires at +12%");

// 5. Concentration: asset at 80% of portfolio → trim to 40%, book kept
r = evaluate(snap([pos("ETH", 4000, 800)], 200), rules, freshState());
ok(r.violations.some((v) => v.rule === "max-position"), "max-position fires at 80%");
ok(r.actions[0].usd === 400 && !r.actions[0].full, "trims exactly the excess, keeps the book");
ok(r.state.entries.ETH, "partial trim keeps entry");

// 6. Circuit breaker: -8% within the rolling window → full liquidation
st = freshState();
r = evaluate(snap([pos("BTC", 100000, 100)], 900), rules, st);
r = evaluate(snap([pos("BTC", 98000, 98)], 900), rules, r.state); // -2%, no trip
r = evaluate(snap([pos("BTC", 96100, 96.1)], 900), rules, r.state); // -3.9% from entry: below SL, but...
ok(!r.violations.some((v) => v.rule === "stop-loss"), "SL quiet below threshold");
r = evaluate(snap([pos("BTC", 92000, 92)], 900), rules, r.state); // window: 98000→92000 = -6.1%
ok(r.violations.some((v) => v.rule === "circuit-breaker"), "circuit breaker catches the flash crash");

// 7. Max drawdown: -15% from peak → de-risk everything
r = evaluate(snap([pos("ETH", 4000, 400)], 450), rules, { ...freshState(), peak: 1000, entries: { ETH: { entry: 4000, high: 4000 } } });
ok(r.violations.some((v) => v.rule === "max-drawdown"), "drawdown fires at -15%");
ok(r.actions[0].usd === 400 && r.actions[0].full, "drawdown liquidates the lot");

// 8. Dust below minTradeUsd never triggers or trades
r = evaluate(snap([pos("DOGE", 0.5, 5)], 1), rules, { ...freshState(), entries: { DOGE: { entry: 1, high: 1 } } });
ok(r.violations.length === 0 && r.actions.length === 0, "dust is ignored entirely");

// 9. Rules compose: worst action wins (stop-loss full sell beats concentration trim)
st = { ...freshState(), entries: { ETH: { entry: 4300, high: 4300 } } };
r = evaluate(snap([pos("ETH", 4000, 800)], 200), rules, st); // -7% AND 80% concentration
const sells = r.actions.filter((a) => a.symbol === "ETHUSDC");
ok(sells.length === 1 && sells[0].usd === 800 && sells[0].full, "one deduped action, full sell wins");

// 10. Drawdown with nothing left to sell stays quiet (no violation spam)
r = evaluate(snap([], 850), rules, { ...freshState(), peak: 1000 });
ok(r.violations.length === 0 && r.actions.length === 0, "all-in-quote drawdown is silent");

console.log(`✅ all ${checks} risk-engine checks passed`);
