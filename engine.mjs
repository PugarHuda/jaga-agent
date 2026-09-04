// Jaga risk engine — pure, deterministic, unit-tested. No LLM in this file, ever.
//
// snapshot: { positions: [{asset, qty, price, usd}], quote, quoteFree, total }
// rules:    { quote, stopLossPct, trailingStopPct?, takeProfitPct?, maxPositionPct,
//             maxDrawdownPct, minTradeUsd, volatility?: {window, dropPct}, mode }
// state:    { peak, entries: {ASSET: {entry, high}}, history: {ASSET: [price,...]} }
//
// Returns { violations, actions, state }. Actions are SELL-to-quote orders only —
// Jaga never buys, never withdraws, never widens exposure.

export function freshState() {
  return { peak: 0, entries: {}, history: {} };
}

export function evaluate(snapshot, rules, state) {
  const s = {
    peak: Math.max(state.peak ?? 0, snapshot.total),
    entries: { ...state.entries },
    history: { ...state.history },
  };
  const violations = [];
  const sells = {}; // asset -> { usd, full }
  const window = rules.volatility?.window ?? 5;

  const addSell = (asset, usd, full) => {
    const cur = sells[asset] ?? { usd: 0, full: false };
    sells[asset] = { usd: Math.max(cur.usd, usd), full: cur.full || full };
  };

  for (const p of snapshot.positions) {
    if (p.usd < rules.minTradeUsd) continue; // dust — not worth guarding or spamming about

    // book-keeping: entry on first sight, high-water mark, rolling price window
    if (!s.entries[p.asset]) s.entries[p.asset] = { entry: p.price, high: p.price };
    else s.entries[p.asset] = { ...s.entries[p.asset], high: Math.max(s.entries[p.asset].high, p.price) };
    const hist = [...(s.history[p.asset] ?? []), p.price].slice(-window);
    s.history[p.asset] = hist;

    const { entry, high } = s.entries[p.asset];
    const fromEntryPct = ((p.price - entry) / entry) * 100;
    const fromHighPct = ((high - p.price) / high) * 100;

    // 1. hard stop-loss from entry
    if (-fromEntryPct >= rules.stopLossPct) {
      violations.push({
        rule: "stop-loss",
        asset: p.asset,
        severity: "high",
        detail: `${p.asset} down ${(-fromEntryPct).toFixed(1)}% from entry ${entry.toFixed(2)} (limit ${rules.stopLossPct}%)`,
      });
      addSell(p.asset, p.usd, true);
    }

    // 2. trailing stop from high-water mark (locks in gains a fixed stop can't)
    if (rules.trailingStopPct && fromHighPct >= rules.trailingStopPct && high > entry) {
      violations.push({
        rule: "trailing-stop",
        asset: p.asset,
        severity: "high",
        detail: `${p.asset} down ${fromHighPct.toFixed(1)}% from high ${high.toFixed(2)} (trail ${rules.trailingStopPct}%)`,
      });
      addSell(p.asset, p.usd, true);
    }

    // 3. take-profit: realize gains past target
    if (rules.takeProfitPct && fromEntryPct >= rules.takeProfitPct) {
      violations.push({
        rule: "take-profit",
        asset: p.asset,
        severity: "info",
        detail: `${p.asset} up ${fromEntryPct.toFixed(1)}% from entry ${entry.toFixed(2)} (target ${rules.takeProfitPct}%) — locking in`,
      });
      addSell(p.asset, p.usd, true);
    }

    // 4. concentration limit: trim, don't liquidate
    const pct = (p.usd / snapshot.total) * 100;
    const excess = p.usd - (snapshot.total * rules.maxPositionPct) / 100;
    if (pct > rules.maxPositionPct && excess >= rules.minTradeUsd) {
      // only report what we'd actually act on — a dust excess is noise, not risk
      violations.push({
        rule: "max-position",
        asset: p.asset,
        severity: "medium",
        detail: `${p.asset} is ${pct.toFixed(1)}% of portfolio (limit ${rules.maxPositionPct}%)`,
      });
      addSell(p.asset, excess, false);
    }

    // 5. volatility circuit breaker: flash-crash inside the rolling window
    if (rules.volatility && hist.length >= 2) {
      const windowDropPct = ((hist[0] - p.price) / hist[0]) * 100;
      if (windowDropPct >= rules.volatility.dropPct) {
        violations.push({
          rule: "circuit-breaker",
          asset: p.asset,
          severity: "high",
          detail: `${p.asset} crashed ${windowDropPct.toFixed(1)}% within ${hist.length} ticks (limit ${rules.volatility.dropPct}%)`,
        });
        addSell(p.asset, p.usd, true);
      }
    }
  }

  // 6. portfolio-level max drawdown: de-risk everything
  const ddPct = s.peak > 0 ? ((s.peak - snapshot.total) / s.peak) * 100 : 0;
  if (ddPct >= rules.maxDrawdownPct) {
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
