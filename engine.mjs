// Jaga risk engine — pure, deterministic, unit-tested. No LLM in this file, ever.
//
// snapshot: { positions: [{asset, qty, price, usd}], quote, quoteFree, total }
// rules:    { quote, stopLossPct, trailingStopPct?, takeProfitPct?, maxPositionPct,
//             maxDrawdownPct, minTradeUsd, volatility?: {window, dropPct}, mode,
//             assets?: { BTC: { stopLossPct: 10, ... } },  ← per-asset overrides
//             maxExposurePct?: 80,     ← cap on total non-quote exposure
//             maxDailyLossPct?: 5 }    ← cap on loss since 00:00 UTC (prop-desk style)
// state:    { peak, entries: {ASSET: {entry, high, qty}}, history: {ASSET: [price,...]},
//             day: {date, start} }   ← equity at the start of the current UTC day
//           entry is a running cost basis: when the position grows, the new lot is
//           averaged in at its price; trims keep the basis.
//
// Returns { violations, actions, state }. Actions are SELL-to-quote orders only —
// Jaga never buys, never withdraws, never widens exposure.

export function freshState() {
  return { peak: 0, entries: {}, history: {}, day: null };
}

export function evaluate(snapshot, rules, state) {
  const today = new Date(snapshot.ts ?? Date.now()).toISOString().slice(0, 10);
  const s = {
    peak: Math.max(state.peak ?? 0, snapshot.total),
    entries: { ...state.entries },
    history: { ...state.history },
    day: state.day?.date === today ? state.day : { date: today, start: snapshot.total }, // new UTC day → new baseline
  };
  const violations = [];
  const sells = {}; // asset -> { usd, full, qty }
  const window = rules.volatility?.window ?? 5;
  const qtyOf = Object.fromEntries(snapshot.positions.map((p) => [p.asset, p.qty]));

  const addSell = (asset, usd, full) => {
    const cur = sells[asset] ?? { usd: 0, full: false };
    sells[asset] = { usd: Math.max(cur.usd, usd), full: cur.full || full, qty: qtyOf[asset] };
  };

  for (const p of snapshot.positions) {
    const R = rules.assets?.[p.asset] ? { ...rules, ...rules.assets[p.asset] } : rules; // per-asset overrides
    if (p.usd < R.minTradeUsd) continue; // dust — not worth guarding or spamming about

    // book-keeping: cost-basis entry, high-water mark, rolling price window
    const prev = s.entries[p.asset];
    if (!prev) s.entries[p.asset] = { entry: p.price, high: p.price, qty: p.qty };
    else {
      const grew = prev.qty > 0 && p.qty > prev.qty * 1.005; // new lot bought (by anyone) → average it in
      const entry = grew ? (prev.entry * prev.qty + p.price * (p.qty - prev.qty)) / p.qty : prev.entry;
      s.entries[p.asset] = { entry, high: Math.max(prev.high, p.price, grew ? entry : 0), qty: p.qty };
    }
    const hist = [...(s.history[p.asset] ?? []), p.price].slice(-window);
    s.history[p.asset] = hist;

    const { entry, high } = s.entries[p.asset];
    const fromEntryPct = ((p.price - entry) / entry) * 100;
    const fromHighPct = ((high - p.price) / high) * 100;

    // 1. hard stop-loss from entry
    if (-fromEntryPct >= R.stopLossPct) {
      violations.push({
        rule: "stop-loss",
        asset: p.asset,
        severity: "high",
        detail: `${p.asset} down ${(-fromEntryPct).toFixed(1)}% from entry ${entry.toFixed(2)} (limit ${R.stopLossPct}%)`,
      });
      addSell(p.asset, p.usd, true);
    }

    // 2. trailing stop from high-water mark (locks in gains a fixed stop can't)
    if (R.trailingStopPct && fromHighPct >= R.trailingStopPct && high > entry) {
      violations.push({
        rule: "trailing-stop",
        asset: p.asset,
        severity: "high",
        detail: `${p.asset} down ${fromHighPct.toFixed(1)}% from high ${high.toFixed(2)} (trail ${R.trailingStopPct}%)`,
      });
      addSell(p.asset, p.usd, true);
    }

    // 3. take-profit: realize gains past target
    if (R.takeProfitPct && fromEntryPct >= R.takeProfitPct) {
      violations.push({
        rule: "take-profit",
        asset: p.asset,
        severity: "info",
        detail: `${p.asset} up ${fromEntryPct.toFixed(1)}% from entry ${entry.toFixed(2)} (target ${R.takeProfitPct}%) — locking in`,
      });
      addSell(p.asset, p.usd, true);
    }

    // 4. concentration limit: trim, don't liquidate
    const pct = (p.usd / snapshot.total) * 100;
    const excess = p.usd - (snapshot.total * R.maxPositionPct) / 100;
    if (pct > R.maxPositionPct && excess >= R.minTradeUsd) {
      // only report what we'd actually act on — a dust excess is noise, not risk
      violations.push({
        rule: "max-position",
        asset: p.asset,
        severity: "medium",
        detail: `${p.asset} is ${pct.toFixed(1)}% of portfolio (limit ${R.maxPositionPct}%)`,
      });
      addSell(p.asset, excess, false);
    }

    // 5. volatility circuit breaker: flash-crash inside the rolling window
    if (R.volatility && hist.length >= 2) {
      const windowDropPct = ((hist[0] - p.price) / hist[0]) * 100;
      if (windowDropPct >= R.volatility.dropPct) {
        violations.push({
          rule: "circuit-breaker",
          asset: p.asset,
          severity: "high",
          detail: `${p.asset} crashed ${windowDropPct.toFixed(1)}% within ${hist.length} ticks (limit ${R.volatility.dropPct}%)`,
        });
        addSell(p.asset, p.usd, true);
      }
    }
  }

  // 6a. total exposure cap: too much of the book in non-quote assets → trim each position pro-rata
  const exposure = snapshot.positions.reduce((t, p) => t + p.usd, 0);
  const exposurePct = snapshot.total > 0 ? (exposure / snapshot.total) * 100 : 0;
  if (rules.maxExposurePct && exposurePct > rules.maxExposurePct) {
    const excess = exposure - (snapshot.total * rules.maxExposurePct) / 100;
    if (excess >= rules.minTradeUsd) {
      violations.push({
        rule: "max-exposure",
        asset: "*",
        severity: "medium",
        detail: `${exposurePct.toFixed(1)}% of portfolio in non-${snapshot.quote} assets (limit ${rules.maxExposurePct}%) — trimming ${excess.toFixed(2)} pro-rata`,
      });
      for (const p of snapshot.positions) if (p.usd >= rules.minTradeUsd) addSell(p.asset, (excess * p.usd) / exposure, false);
    }
  }

  // 6b. daily loss limit: down N% since the start of the UTC day → de-risk everything (prop-desk rule)
  const sellable = snapshot.positions.some((p) => p.usd >= rules.minTradeUsd);
  const dayLossPct = s.day.start > 0 ? ((s.day.start - snapshot.total) / s.day.start) * 100 : 0;
  if (rules.maxDailyLossPct && dayLossPct >= rules.maxDailyLossPct && sellable) {
    violations.push({
      rule: "daily-loss",
      asset: "*",
      severity: "critical",
      detail: `portfolio down ${dayLossPct.toFixed(1)}% since 00:00 UTC (start ${s.day.start.toFixed(2)}, limit ${rules.maxDailyLossPct}%) — de-risking everything for the day`,
    });
    for (const p of snapshot.positions) if (p.usd >= rules.minTradeUsd) addSell(p.asset, p.usd, true);
  }

  // 6. portfolio-level max drawdown: de-risk everything
  // only fires while there's something left to sell — once we're fully in quote,
  // repeating "still down from peak" every tick is noise, not protection
  const ddPct = s.peak > 0 ? ((s.peak - snapshot.total) / s.peak) * 100 : 0;
  if (ddPct >= rules.maxDrawdownPct && sellable) {
    violations.push({
      rule: "max-drawdown",
      asset: "*",
      severity: "critical",
      detail: `portfolio down ${ddPct.toFixed(1)}% from peak ${s.peak.toFixed(2)} (limit ${rules.maxDrawdownPct}%) — de-risking everything`,
    });
    for (const p of snapshot.positions) if (p.usd >= rules.minTradeUsd) addSell(p.asset, p.usd, true);
  }

  const actions = Object.entries(sells)
    .filter(([, x]) => x.usd >= rules.minTradeUsd)
    .map(([asset, x]) => ({
      side: "SELL",
      symbol: `${asset}${snapshot.quote}`,
      usd: Math.round(x.usd * 100) / 100,
      full: x.full,
      ...(x.full && x.qty ? { qty: x.qty } : {}), // full sells carry the exact base quantity → sized as a quantity order, never over-asks
    }));

  // full liquidation resets the book for that asset so remainders/dust can't re-trigger
  for (const a of actions) {
    if (!a.full) continue;
    const asset = a.symbol.slice(0, -snapshot.quote.length);
    delete s.entries[asset];
    delete s.history[asset];
  }

  return { violations, actions, state: s };
}
