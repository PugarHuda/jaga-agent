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

// 11. Cost basis: a second lot averages the entry, a trim keeps it
st = freshState();
r = evaluate(snap([pos("ETH", 4000, 400)], 600), rules, st); // 0.1 ETH @ 4000
r = evaluate(snap([{ asset: "ETH", qty: 0.2, price: 4800, usd: 960 }], 120), rules, r.state); // +0.1 ETH @ 4800 (paid 480)
ok(Math.abs(r.state.entries.ETH.entry - 4400) < 1e-9, "entry becomes the weighted cost basis (4400)");
ok(!r.violations.some((v) => v.rule === "take-profit"), "+9% vs basis: no false take-profit after averaging up");
r = evaluate(snap([{ asset: "ETH", qty: 0.15, price: 4800, usd: 720 }], 360), rules, r.state); // trimmed 0.05 (got 240)
ok(Math.abs(r.state.entries.ETH.entry - 4400) < 1e-9, "a trim keeps the cost basis");

// 12. Per-asset override: BTC tolerates -8% when its stop-loss is 10%
const perAsset = { ...rules, assets: { BTC: { stopLossPct: 10 } } };
st = { ...freshState(), entries: { BTC: { entry: 100000, high: 100000, qty: 0.001 }, ETH: { entry: 4000, high: 4000, qty: 0.1 } } };
r = evaluate(snap([pos("BTC", 92000, 92), pos("ETH", 3680, 368)], 500), perAsset, st); // both -8%
ok(!r.violations.some((v) => v.rule === "stop-loss" && v.asset === "BTC"), "BTC override holds at -8%");
ok(r.violations.some((v) => v.rule === "stop-loss" && v.asset === "ETH"), "ETH default 5% stop still fires");

// 13. Full sells carry the base quantity; trims don't
r = evaluate(snap([pos("BTC", 94000, 94)], 200), rules, { ...freshState(), entries: { BTC: { entry: 100000, high: 100000, qty: 0.001 } } });
ok(Math.abs(r.actions[0].qty - 0.001) < 1e-12 && r.actions[0].full, "stop-loss action carries qty for a quantity-sized order");
r = evaluate(snap([pos("ETH", 4000, 800)], 200), rules, freshState());
ok(r.actions[0].qty === undefined && !r.actions[0].full, "trim is quote-sized, no qty");

// 14. Max exposure: 90% in crypto with an 80% cap → pro-rata trims totalling the excess
const exp = { ...rules, maxExposurePct: 80, maxPositionPct: 100 };
r = evaluate(snap([pos("BTC", 100000, 600), pos("ETH", 4000, 300)], 100), exp, freshState());
ok(r.violations.some((v) => v.rule === "max-exposure"), "max-exposure fires at 90%");
const trimmed = r.actions.reduce((a, x) => a + x.usd, 0);
ok(Math.abs(trimmed - 100) < 0.02 && r.actions.every((a) => !a.full), "trims exactly the excess (100), pro-rata, partial");
ok(Math.abs(r.actions.find((a) => a.symbol === "BTCUSDC").usd - 66.67) < 0.02, "BTC takes 2/3 of the trim");

// 15. Daily loss: -6% since the UTC day start with a 5% cap → de-risk everything; a new day resets the baseline
const daily = { ...rules, maxDailyLossPct: 5 };
const t0 = Date.UTC(2026, 8, 6, 1, 0, 0);
r = evaluate({ ...snap([pos("ETH", 4000, 400)], 600), ts: t0 }, daily, freshState()); // day start = 1000
ok(r.state.day.date === "2026-09-06" && r.state.day.start === 1000, "day baseline recorded at first sight");
r = evaluate({ ...snap([pos("ETH", 3400, 340)], 600), ts: t0 + 3600e3 }, daily, r.state); // ETH -15% → total 940 = -6%, quote untouched
ok(r.violations.some((v) => v.rule === "daily-loss") && r.actions[0].full, "daily-loss de-risks at -6% intraday");
r = evaluate({ ...snap([pos("ETH", 3400, 340)], 600), ts: t0 + 24 * 3600e3 }, daily, { ...r.state, entries: { ETH: { entry: 3400, high: 3400, qty: 0.1 } } });
ok(r.state.day.date === "2026-09-07" && r.state.day.start === 940 && !r.violations.some((v) => v.rule === "daily-loss"), "next UTC day resets the baseline");

// 16. Deposits/withdrawals are cash flows, not market moves
st = freshState();
r = evaluate(snap([pos("ETH", 4000, 400)], 600), rules, st); // total 1000, peak 1000
r = evaluate(snap([pos("ETH", 4000, 400)], 100), rules, r.state); // user withdrew 500 USDC → total 500
ok(!r.violations.some((v) => v.rule === "max-drawdown"), "a withdrawal is not a drawdown");
ok(Math.abs(r.state.peak - 500) < 1e-9 && Math.abs(r.state.day.start - 500) < 1e-9, "peak and day baseline rebased by the withdrawal");
r = evaluate(snap([pos("ETH", 4000, 400)], 1100), rules, r.state); // deposit 1000 → total 1500
ok(Math.abs(r.state.peak - 1500) < 1e-9 && Math.abs(r.state.flow - 1000) < 1e-9, "a deposit rebases too (flow detected)");
r = evaluate(snap([pos("ETH", 3600, 360)], 1100), rules, r.state); // real market move: ETH -10% → total 1460
ok(Math.abs(r.state.flow) < 1e-9 && r.state.peak === 1500, "a market move is not a flow; peak stays");
r = evaluate(snap([], 1460), rules, { ...r.state, entries: { ETH: { entry: 4000, high: 4000, qty: 0.1 } } }); // Jaga sold 0.1 ETH @ 3600 → quote +360
ok(Math.abs(r.state.flow) < 1e-9, "a sell (exposure→quote) is not a flow");
r = evaluate(snap([pos("BTC", 50000, 500)], 1460), rules, r.state); // 0.01 BTC deposited as a coin, no quote change
ok(Math.abs(r.state.flow - 500) < 1e-9 && r.state.peak === 2000, "a coin deposit is a flow too (peak rebased, not a windfall)");
r = evaluate(snap([pos("BTC", 50000, 500)], 1080), rules, r.state); // 380 withdrawn (26% of quote)
ok(Math.abs(r.state.flow + 380) < 1e-9 && !r.violations.some((v) => v.rule === "max-drawdown"), "withdrawal after a deposit still isn't a drawdown");

// 17. An asset that leaves the wallet loses its stale cost basis
st = freshState();
r = evaluate(snap([pos("SOL", 100, 100)], 900), rules, st);
r = evaluate(snap([], 1000), rules, r.state); // sold elsewhere
ok(!r.state.entries.SOL, "entry dropped when the asset is gone");
r = evaluate(snap([pos("SOL", 80, 80)], 920), rules, r.state); // re-bought lower
ok(r.state.entries.SOL.entry === 80 && !r.violations.some((v) => v.rule === "stop-loss"), "re-buy starts a fresh basis, no phantom -20% stop");
r = evaluate({ ...snap([], 920), unpriced: [{ asset: "SOL", qty: 1, price: 80, usd: 80 }] }, rules, r.state);
ok(r.state.entries.SOL, "an asset that is merely unpriced this tick keeps its entry");

// 18. Headroom: every rule reports its reading vs limit, hottest first, before anything trips
st = { ...freshState(), entries: { ETH: { entry: 4000, high: 4200, qty: 0.1 } } };
r = evaluate(snap([pos("ETH", 4040, 404)], 596.8), rules, { ...st, peak: 1020, day: { date: new Date().toISOString().slice(0, 10), start: 1010 } }); // -3.8% from high, +1% from entry, 40.4% of book
ok(r.violations.length === 0 || r.violations.every((v) => v.rule === "max-position"), "scenario stays below the hard limits");
const hr = Object.fromEntries(r.headroom.map((h) => [h.rule + ":" + h.asset, h]));
ok(hr["trailing-stop:ETH"] && hr["trailing-stop:ETH"].pct === 95, "trailing stop reads 3.8/4 → 95% (about to trip)");
ok(hr["stop-loss:ETH"].pct === 0 && hr["take-profit:ETH"].pct === 10, "stop-loss 0% (in profit), take-profit 10% of the way");
ok(hr["max-drawdown:*"].limit === 10 && Math.abs(hr["max-drawdown:*"].value - 1.88) < 0.01, "portfolio drawdown gauge: 1.88% of 10%");
ok(hr["daily-loss:*"] === undefined, "rules that aren't configured have no gauge");
ok(r.headroom[0].rule === "trailing-stop" || r.headroom[0].rule === "max-position", "hottest rule sorts first");

// 19. Time-based volatility window: seconds, not ticks (stop-loss relaxed so only the breaker is under test)
const tv = { ...rules, stopLossPct: 50, volatility: { windowSec: 60, dropPct: 6 } };
const T = Date.UTC(2026, 8, 6, 12, 0, 0);
st = freshState();
r = evaluate({ ...snap([pos("BTC", 100000, 100)], 900), ts: T }, tv, st);
r = evaluate({ ...snap([pos("BTC", 99000, 99)], 900), ts: T + 20e3 }, tv, r.state);
r = evaluate({ ...snap([pos("BTC", 93500, 93.5)], 900), ts: T + 50e3 }, tv, r.state); // -6.5% inside 50s
ok(r.violations.some((v) => v.rule === "circuit-breaker") && /within 50s/.test(r.violations.find((v) => v.rule === "circuit-breaker").detail), "circuit breaker measures seconds when windowSec is set");
st = freshState();
r = evaluate({ ...snap([pos("BTC", 100000, 100)], 900), ts: T }, tv, st);
r = evaluate({ ...snap([pos("BTC", 97000, 97)], 900), ts: T + 90e3 }, tv, r.state); // first sample aged out (90s > 60s)
r = evaluate({ ...snap([pos("BTC", 94000, 94)], 900), ts: T + 120e3 }, tv, r.state); // -3.1% vs the 97000 sample still in window
ok(!r.violations.some((v) => v.rule === "circuit-breaker"), "samples older than windowSec age out — a slow bleed is not a flash crash");
ok(r.state.history.BTC.length === 2 && r.state.history.BTC.every((h) => typeof h.p === "number" && typeof h.t === "number"), "history carries timestamps and drops aged-out samples");
r = evaluate({ ...snap([pos("BTC", 96000, 96)], 900), ts: T + 121e3 }, tv, { ...r.state, history: { BTC: [100000, 97000] } }); // legacy state shape
ok(r.state.history.BTC.every((h) => typeof h.p === "number"), "legacy bare-number history is upgraded without crashing");

console.log(`✅ all ${checks} risk-engine checks passed`);
