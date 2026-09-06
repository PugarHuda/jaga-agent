// Jaga live dashboard — zero-dependency HTTP + SSE. One page, dark, judge-friendly.
import http from "node:http";
import { timingSafeEqual } from "node:crypto";

const PAGE = /* html */ `<!doctype html>
<html><head><meta charset="utf-8"><title>Jaga 🛡️ — live guard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{--bg:#0b0e14;--card:#131824;--line:#1f2937;--txt:#e5e7eb;--dim:#8b93a7;
        --green:#34d399;--red:#f87171;--amber:#fbbf24;--blue:#60a5fa;--purple:#c084fc}
  *{box-sizing:border-box;margin:0}
  body{background:var(--bg);color:var(--txt);font:14px/1.5 ui-monospace,Consolas,monospace;padding:20px}
  h1{font-size:20px;margin-bottom:2px} .sub{color:var(--dim);margin-bottom:18px;font-size:12px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:16px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
  .card .k{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.08em}
  .card .v{font-size:22px;margin-top:4px;font-variant-numeric:tabular-nums}
  .row{display:grid;grid-template-columns:1.2fr 1fr;gap:12px}
  .row>.card{min-width:0}
  @media(max-width:900px){.row{grid-template-columns:1fr}}
  canvas{width:100%;height:180px}
  table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
  th,td{text-align:right;padding:6px 8px;border-bottom:1px solid var(--line)}
  th:first-child,td:first-child{text-align:left}
  th{color:var(--dim);font-size:11px;text-transform:uppercase}
  #feed{max-height:340px;overflow-y:auto;display:flex;flex-direction:column;gap:8px}
  .ev{border-left:3px solid var(--blue);background:#0f1420;padding:8px 10px;border-radius:0 8px 8px 0;font-size:12px}
  .ev .t{color:var(--dim);font-size:10px}
  .ev.violation{border-color:var(--amber)} .ev.action{border-color:var(--red)}
  .ev.report,.ev.advisor{border-color:var(--purple);white-space:pre-wrap}
  .badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:10px;margin-right:6px;
         background:#1e293b;color:var(--blue)}
  .ev.violation .badge{color:var(--amber)} .ev.action .badge{color:var(--red)}
  .ev.advisor .badge,.ev.report .badge{color:var(--purple)}
  .up{color:var(--green)} .down{color:var(--red)}
  h2{font-size:13px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;margin:14px 0 8px}
</style></head><body>
<div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:12px">
<div><h1>Jaga 🛡️ <span id="dot" style="color:var(--green)">●</span> live</h1>
<div class="sub">deterministic risk guardian · Binance Agent OS (MCP) · code enforces, AI explains</div></div>
<button id="panic" title="Sell every position to the quote asset now, regardless of mode" style="padding:8px 14px;border-radius:8px;border:1px solid var(--red);background:#2a1215;color:var(--red);cursor:pointer;font:inherit;font-weight:700">🚨 De-risk everything</button>
</div>
<div class="grid">
  <div class="card"><div class="k">Portfolio</div><div class="v" id="total">—</div></div>
  <div class="card"><div class="k">Peak</div><div class="v" id="peak">—</div></div>
  <div class="card"><div class="k">Drawdown</div><div class="v" id="dd">—</div></div>
  <div class="card"><div class="k">Mode</div><div class="v" id="mode">—</div></div>
  <div class="card"><div class="k">Interventions</div><div class="v" id="acts">0</div></div>
  <div class="card"><div class="k">Damage avoided</div><div class="v" id="saved">—</div></div>
  <div class="card"><div class="k">Threat (AI analyst)</div><div class="v" id="threat">—</div></div>
</div>
<div class="card" id="pendingCard" style="display:none;margin-bottom:16px;border-color:var(--amber)">
  <h2 style="margin-top:0">⏳ Pending approvals (mode: propose)</h2>
  <div id="pending" style="display:flex;flex-direction:column;gap:8px"></div>
</div>
<div class="row">
  <div class="card"><h2>Equity curve</h2><canvas id="chart" width="800" height="180"></canvas>
    <h2>Positions</h2><div style="overflow-x:auto"><table id="pos"><tr><th>Asset</th><th>Qty</th><th>Price</th><th>vs entry</th><th>Value</th><th>% Port</th></tr></table></div>
  </div>
  <div class="card"><h2>Rule headroom</h2><table id="hr"><tr><th>Rule</th><th>Asset</th><th>Reading / limit</th><th style="width:38%">Closeness</th></tr></table>
    <h2>Incident feed</h2><div id="feed" role="log" aria-live="polite" aria-relevant="additions"></div></div>
</div>
<script>
const $=id=>document.getElementById(id);
let series=[],acts=0;
function fmt(n){return n>=1000?n.toLocaleString(undefined,{maximumFractionDigits:2}):n.toFixed(2)}
function draw(){
  const c=$("chart"),x=c.getContext("2d");x.clearRect(0,0,c.width,c.height);
  if(series.length<2)return;
  const min=Math.min(...series),max=Math.max(...series),pad=8,
        sx=i=>pad+i*(c.width-2*pad)/(series.length-1),
        sy=v=>c.height-pad-((v-min)/((max-min)||1))*(c.height-2*pad);
  x.beginPath();series.forEach((v,i)=>i?x.lineTo(sx(i),sy(v)):x.moveTo(sx(i),sy(v)));
  x.strokeStyle=series.at(-1)>=series[0]?"#34d399":"#f87171";x.lineWidth=2;x.stroke();
  x.lineTo(sx(series.length-1),c.height-pad);x.lineTo(sx(0),c.height-pad);x.closePath();
  x.fillStyle=(series.at(-1)>=series[0]?"#34d399":"#f87171")+"18";x.fill();
}
$("panic").onclick=()=>{if(confirm("Sell EVERY position to the quote asset right now?"))fetch("/panic",{method:"POST",headers:{"content-type":"application/json"},body:"{}"})};
function decide(id,approve){
  fetch("/decide",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({id,approve})});
}
function renderPending(ev){
  const d=document.createElement("div");d.className="ev action";d.dataset.id=ev.id;
  const t=document.createElement("span");t.textContent=ev.text+" ";
  const yes=document.createElement("button");yes.textContent="✅ Approve";
  const no=document.createElement("button");no.textContent="❌ Reject";
  for(const b of [yes,no])b.style.cssText="margin-left:8px;padding:2px 10px;border-radius:6px;border:1px solid var(--line);background:#1e293b;color:var(--txt);cursor:pointer";
  yes.onclick=()=>decide(ev.id,true);no.onclick=()=>decide(ev.id,false);
  d.append(t,yes,no);$("pending").append(d);$("pendingCard").style.display="block";
}
function removePending(id){
  document.querySelectorAll('#pending [data-id="'+CSS.escape(id)+'"]').forEach(e=>e.remove());
  if(!$("pending").children.length)$("pendingCard").style.display="none";
}
function threat(level){const c={LOW:"var(--green)",MEDIUM:"var(--amber)",HIGH:"var(--red)",CRITICAL:"var(--red)"};$("threat").textContent=level;$("threat").style.color=c[level]||"var(--txt)"}
function feed(ev){
  // MCP/LLM text is untrusted → textContent only, never innerHTML
  const d=document.createElement("div");d.className="ev "+ev.type;
  const b=document.createElement("span");b.className="badge";b.textContent=ev.rule??ev.type;
  const t=document.createElement("div");t.className="t";t.textContent=new Date(ev.ts).toLocaleTimeString();
  d.append(b,document.createTextNode(ev.text??""),t);
  $("feed").prepend(d);
  while($("feed").children.length>80)$("feed").lastChild.remove();
}
function tick(ev){
  series.push(ev.total);if(series.length>300)series.shift();draw();
  $("total").textContent=fmt(ev.total)+" "+ev.quote;
  $("peak").textContent=fmt(ev.peak)+" "+ev.quote;
  const dd=ev.peak?((ev.peak-ev.total)/ev.peak*100):0;
  const ddLim=ev.limits?.maxDrawdownPct;$("dd").textContent=dd.toFixed(1)+"%"+(ddLim?" / "+ddLim+"%":"");$("dd").className="v "+(ddLim&&dd>=ddLim*0.6?"down":"up");
  $("mode").textContent=ev.mode;
  if(ev.avoided!==undefined){
    $("saved").textContent=(ev.avoided>=0?"+":"")+fmt(ev.avoided)+" "+ev.quote;
    $("saved").className="v "+(ev.avoided>=0?"up":"down");
  }
  const h=$("hr");h.textContent="";
  const hrow=(cells,th)=>{const r=document.createElement("tr");for(const c of cells){const e=document.createElement(th?"th":"td");if(c instanceof Node)e.append(c);else e.textContent=c;r.append(e)}h.append(r);return r};
  hrow(["Rule","Asset","Reading / limit","Closeness"],true);
  for(const g of ev.headroom??[]){const bar=document.createElement("div");bar.style.cssText="height:8px;border-radius:4px;background:#1e293b;overflow:hidden";
    const fill=document.createElement("div");fill.style.cssText="height:100%;width:"+Math.min(100,g.pct)+"%;background:"+(g.pct>=90?"var(--red)":g.pct>=60?"var(--amber)":"var(--green)");bar.append(fill);
    const r=hrow([g.rule,g.asset,g.value.toFixed(2)+"% / "+g.limit+"%",bar]);r.lastChild.title=g.pct+"%";if(g.pct>=90)r.children[0].className="down"}
  const tbl=$("pos");tbl.textContent="";
  const tr=(cells,th)=>{const r=document.createElement("tr");
    for(const c of cells){const e=document.createElement(th?"th":"td");e.textContent=c;r.append(e)}
    tbl.append(r);return r};
  tr(["Asset","Qty","Price","vs entry","Value","% Port"],true);
  const cap=ev.limits?.maxPositionPct;
  for(const p of ev.positions){const pct=p.usd/ev.total*100;const pnl=p.entry?(p.price-p.entry)/p.entry*100:null;
    const r=tr([p.asset,p.qty.toFixed(6),fmt(p.price),pnl===null?"—":(pnl>=0?"+":"")+pnl.toFixed(2)+"%",fmt(p.usd),pct.toFixed(1)+"%"+(cap?" / "+cap+"%":"")]);
    if(pnl!==null)r.children[3].className=pnl>=0?"up":"down";if(cap&&pct>cap)r.lastChild.className="down"}
  for(const p of ev.unpriced??[])tr([p.asset+" (valued via bridge, not tradable)",p.qty.toFixed(6),fmt(p.price),"—",fmt(p.usd),(p.usd/ev.total*100).toFixed(1)+"%"]);
  tr([ev.quote,"","","",fmt(ev.quoteFree),(ev.quoteFree/ev.total*100).toFixed(1)+"%"]);
}
// server injects current state at serve time — first paint is already live
const BOOT=__BOOT__;
series=BOOT.series;acts=BOOT.actions;$("acts").textContent=acts;draw();
BOOT.events.forEach(feed);const lastAdv=BOOT.events.find(e=>e.type==="advisor"&&e.level);if(lastAdv)threat(lastAdv.level);BOOT.pending.forEach(renderPending);if(BOOT.lastTick)tick(BOOT.lastTick);
let dropped=false;const es=new EventSource("/events");
es.onopen=()=>{$("dot").style.color="var(--green)";if(dropped)location.reload()};
es.onerror=()=>{$("dot").style.color="var(--dim)";dropped=true};
es.onmessage=m=>{
  const ev=JSON.parse(m.data);
  if(ev.type==="tick")return tick(ev);
  if(ev.type==="decision")return removePending(ev.id);
  if(ev.type==="proposal")renderPending(ev);
  if(ev.type==="action"){acts++;$("acts").textContent=acts}
  if(ev.type==="advisor"&&ev.level)threat(ev.level);
  feed(ev);
};
</script></body></html>`;

export function startDashboard(port, { onDecision, onPanic, metrics, health, mcp: mcpHandler, host = "127.0.0.1", token = null } = {}) {
  const clients = new Set();
  const store = { series: [], events: [], actions: 0, lastTick: null, pending: [] };
  const broadcast = (ev) => {
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    clients.forEach((c) => c.write(line));
  };

  // Auth: with a token configured, every route except /healthz needs it — as a
  // Bearer header (curl, MCP clients, Prometheus) or the cookie the browser gets by
  // opening /?token=… once. Required whenever the dashboard binds beyond loopback.
  const authed = (req) => {
    if (!token) return true;
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const cookie = (req.headers.cookie ?? "").split(";").map((c) => c.trim()).find((c) => c.startsWith("jaga="))?.slice(5);
    const same = (a) => typeof a === "string" && a.length === token.length && timingSafeEqual(Buffer.from(a), Buffer.from(token));
    return same(bearer) || same(cookie);
  };
  // CSRF guard for state-changing POSTs: browsers always send Origin on cross-site
  // POSTs — reject any origin that isn't this dashboard itself (curl/local tools send
  // none). JSON-only: an HTML form can't send that content-type cross-site without preflight.
  const guarded = (req, res) => {
    const origin = req.headers.origin;
    let self = false;
    try {
      self = Boolean(origin && req.headers.host && new URL(origin).host === req.headers.host);
    } catch {} // Origin: null (sandboxed/about:blank pages) is not a URL — treat as foreign
    if (origin && !self && !/^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return res.writeHead(403).end(), false;
    if (!/^application\/json/.test(req.headers["content-type"] ?? "")) return res.writeHead(415).end(), false;
    return true;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (token && url.pathname === "/" && url.searchParams.get("token") === token) {
      // browser login: exchange ?token= for a cookie, then land on the clean URL
      res.writeHead(302, { "set-cookie": `jaga=${token}; HttpOnly; SameSite=Strict; Path=/`, location: "/" }).end();
      return;
    }
    if (url.pathname !== "/healthz" && !authed(req)) {
      res.writeHead(401, { "content-type": "text/plain", "www-authenticate": "Bearer" }).end("unauthorized — open /?token=<dashboard.token> or send Authorization: Bearer");
      return;
    }
    if (req.method === "POST" && req.url === "/panic") {
      if (!guarded(req, res)) return;
      Promise.resolve(onPanic?.()).catch((e) => console.error("panic failed:", e.message));
      res.writeHead(204).end();
    } else if (req.method === "POST" && req.url === "/decide") {
      if (!guarded(req, res)) return;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const { id, approve } = JSON.parse(body);
          store.pending = store.pending.filter((p) => p.id !== id);
          broadcast({ type: "decision", id, ts: Date.now() });
          Promise.resolve(onDecision?.(id, Boolean(approve))).catch((e) =>
            console.error("decision failed:", e.message)
          );
          res.writeHead(204).end();
        } catch {
          res.writeHead(400).end();
        }
      });
    } else if (req.url === "/healthz" && health) {
      const h = health();
      res.writeHead(h.ok ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify(h));
    } else if (req.url === "/metrics" && metrics) {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(metrics());
    } else if (req.url === "/mcp" && mcpHandler) {
      // Jaga as an MCP server (read-only tools) — same loopback-only port
      mcpHandler(req, res).catch((e) => {
        console.error("mcp handler failed:", e.message);
        if (!res.headersSent) res.writeHead(500).end();
      });
    } else if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(":ok\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
    } else if (req.url === "/state") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(store));
    } else {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      // <-escape keeps untrusted MCP/LLM text from closing the script tag
      res.end(PAGE.replace("__BOOT__", JSON.stringify(store).replace(/</g, "\\u003c")));
    }
  });
  // loopback by default — beyond it, config validation insists on a token
  server.on("error", (e) => {
    // a second Jaga on the same port used to die with a raw stack trace
    console.error(e.code === "EADDRINUSE" ? `❌ port ${port} is already in use (another Jaga running?). Change dashboard.port in your config or stop the other process.` : `❌ dashboard failed: ${e.message}`);
    process.exit(1);
  });
  server.listen(port, host, () => console.log(`📊 dashboard → http://${host === "0.0.0.0" ? "localhost" : host}:${port}${token ? "/?token=…  (token auth on)" : ""}`));
  const heartbeat = setInterval(() => clients.forEach((c) => c.write(":hb\n\n")), 15000);

  return {
    seed(series) {
      store.series = series.slice(-300);
    },
    emit(ev) {
      ev.ts = Date.now();
      if (ev.type === "tick") {
        store.lastTick = ev;
        store.series.push(ev.total);
        if (store.series.length > 300) store.series.shift();
      } else if (ev.type === "proposal") {
        store.pending.push({ id: ev.id, text: ev.text });
      } else if (ev.type === "decision") {
        store.pending = store.pending.filter((p) => p.id !== ev.id);
      } else {
        if (ev.type === "action") store.actions++;
        store.events.unshift(ev);
        store.events.length = Math.min(store.events.length, 80);
      }
      broadcast(ev);
    },
    close() {
      clearInterval(heartbeat);
      clients.forEach((c) => c.end());
      server.close();
    },
  };
}
