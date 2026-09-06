// Normalizers for MCP tool results — the reason Jaga is server-agnostic.
// Different Binance MCP servers (official, community, paper) return balances
// and prices in different shapes; everything funnels through here.

export function toolResult(res) {
  if (res?.isError) throw new Error(`MCP tool error: ${(res.content ?? []).map((c) => c.text).join(" ").slice(0, 200)}`);
  if (res?.structuredContent) return res.structuredContent;
  const text = res?.content?.find((c) => c.type === "text")?.text ?? "{}";
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`non-JSON tool result: ${text.slice(0, 120)}`);
  }
}

// {balances:[{asset,free}]} | [{asset,free}] | {data:{balances}} | {BTC:0.1,...} → [{asset, free}]
export function parseBalances(x) {
  const src = x?.balances ?? x?.data?.balances ?? x?.data ?? x;
  if (Array.isArray(src)) {
    return src
      .map((b) => ({ asset: String(b.asset ?? b.coin ?? b.symbol ?? "").toUpperCase(), free: Number(b.free ?? b.available ?? b.balance ?? b.amount ?? 0) }))
      .filter((b) => b.asset && Number.isFinite(b.free));
  }
  if (src && typeof src === "object") {
    return Object.entries(src)
      .filter(([, v]) => typeof v === "number" || typeof v === "string")
      .map(([asset, v]) => ({ asset: asset.toUpperCase(), free: Number(v) }))
      .filter((b) => Number.isFinite(b.free));
  }
  return [];
}

// {SYM:p} | {SYM:{price}} | [{symbol,price}] | {data:[...]} | {prices:{...}} → {SYM: number}
export function parsePrices(x) {
  const src = x?.prices ?? x?.data ?? x;
  const out = {};
  const key = (s) => String(s).replace("/", "").toUpperCase();
  const num = (v) => Number(typeof v === "object" && v !== null ? v.price ?? v.lastPrice ?? v.close ?? v.c : v);
  if (Array.isArray(src)) {
    for (const p of src) {
      const s = p.symbol ?? p.pair;
      const v = num(p);
      if (s && v > 0) out[key(s)] = v;
    }
  } else if (src && typeof src === "object") {
    for (const [k, v] of Object.entries(src)) {
      const n = num(v);
      if (n > 0) out[key(k)] = n;
    }
  }
  return out;
}

// A risk guardian with a silently-missing rule is worse than none: NaN compares
// false and the rule just never fires. Fail loud at startup instead.
export function validateConfig(cfg) {
  const errs = [];
  const r = cfg?.rules ?? {};
  const positive = (k, required) => {
    const v = r[k];
    if (v === undefined) {
      if (required) errs.push(`rules.${k} is required`);
    } else if (!(Number.isFinite(v) && v > 0)) errs.push(`rules.${k} must be a positive number`);
  };
  for (const k of ["stopLossPct", "maxPositionPct", "maxDrawdownPct", "minTradeUsd"]) positive(k, true);
  for (const k of ["trailingStopPct", "takeProfitPct"]) positive(k, false);
  if (r.volatility !== undefined) {
    if (!(Number.isInteger(r.volatility?.window) && r.volatility.window >= 2)) errs.push("rules.volatility.window must be an integer >= 2");
    if (!(Number.isFinite(r.volatility?.dropPct) && r.volatility.dropPct > 0)) errs.push("rules.volatility.dropPct must be a positive number");
  }
  if (!["propose", "execute"].includes(r.mode)) errs.push('rules.mode must be "propose" or "execute"');
  if (typeof r.quote !== "string" || !/^[A-Z0-9]{2,10}$/.test(r.quote)) errs.push("rules.quote must be an asset symbol like USDC");
  if (!cfg?.mcp?.url && !cfg?.mcp?.command) errs.push("mcp.url or mcp.command is required");
  for (const k of ["account", "prices", "order"]) if (typeof cfg?.tools?.[k] !== "string") errs.push(`tools.${k} (MCP tool name) is required`);
  if (cfg?.intervalSec !== undefined && !(cfg.intervalSec >= 1)) errs.push("intervalSec must be >= 1");
  return errs;
}

