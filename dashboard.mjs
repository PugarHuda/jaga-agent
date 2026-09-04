// Jaga live dashboard — zero-dependency HTTP + SSE. One page, dark, judge-friendly.
import http from "node:http";

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
<h1>Jaga 🛡️ <span style="color:var(--green)">●</span> live</h1>
<div class="sub">deterministic risk guardian · Binance Agent OS (MCP) · code enforces, AI explains</div>
<div class="grid">
  <div class="card"><div class="k">Portfolio</div><div class="v" id="total">—</div></div>
  <div class="card"><div class="k">Peak</div><div class="v" id="peak">—</div></div>
  <div class="card"><div class="k">Drawdown</div><div class="v" id="dd">—</div></div>
  <div class="card"><div class="k">Mode</div><div class="v" id="mode">—</div></div>
  <div class="card"><div class="k">Interventions</div><div class="v" id="acts">0</div></div>
</div>
<div class="row">
  <div class="card"><h2>Equity curve</h2><canvas id="chart" width="800" height="180"></canvas>
    <h2>Positions</h2><table id="pos"><tr><th>Asset</th><th>Qty</th><th>Price</th><th>Value</th><th>% Port</th></tr></table>
  </div>
  <div class="card"><h2>Incident feed</h2><div id="feed"></div></div>
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
  $("dd").textContent=dd.toFixed(1)+"%";$("dd").className="v "+(dd>5?"down":"up");
  $("mode").textContent=ev.mode;
  const tbl=$("pos");tbl.textContent="";
  const tr=(cells,th)=>{const r=document.createElement("tr");
    for(const c of cells){const e=document.createElement(th?"th":"td");e.textContent=c;r.append(e)}
    tbl.append(r)};
  tr(["Asset","Qty","Price","Value","% Port"],true);
  for(const p of ev.positions)tr([p.asset,p.qty.toFixed(6),fmt(p.price),fmt(p.usd),(p.usd/ev.total*100).toFixed(1)+"%"]);
  tr([ev.quote,"","",fmt(ev.quoteFree),(ev.quoteFree/ev.total*100).toFixed(1)+"%"]);
}
fetch("/state").then(r=>r.json()).then(s=>{
  series=s.series;acts=s.actions;$("acts").textContent=acts;draw();
  s.events.forEach(feed);if(s.lastTick)tick(s.lastTick);
});
new EventSource("/events").onmessage=m=>{
  const ev=JSON.parse(m.data);
  if(ev.type==="tick")return tick(ev);
  if(ev.type==="action"){acts++;$("acts").textContent=acts}
  feed(ev);
};
</script></body></html>`;

export function startDashboard(port) {
  const clients = new Set();
  const store = { series: [], events: [], actions: 0, lastTick: null };

  const server = http.createServer((req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(":ok\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
    } else if (req.url === "/state") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(store));
    } else {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
    }
  });
  server.listen(port, () => console.log(`📊 dashboard → http://localhost:${port}`));
  const heartbeat = setInterval(() => clients.forEach((c) => c.write(":hb\n\n")), 15000);

  return {
    emit(ev) {
      ev.ts = Date.now();
      if (ev.type === "tick") {
        store.lastTick = ev;
        store.series.push(ev.total);
        if (store.series.length > 300) store.series.shift();
      } else {
        if (ev.type === "action") store.actions++;
        store.events.unshift(ev);
        store.events.length = Math.min(store.events.length, 80);
      }
      const line = `data: ${JSON.stringify(ev)}\n\n`;
      clients.forEach((c) => c.write(line));
    },
    close() {
      clearInterval(heartbeat);
      clients.forEach((c) => c.end());
      server.close();
    },
  };
}
