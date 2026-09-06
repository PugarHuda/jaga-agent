// Build the public demo (public/index.html): run the REAL stack against the replayed
// Aug-2024 crash, record every dashboard event, then bake those events into the very
// same dashboard page with a replayer in place of the SSE stream. Nothing is faked and
// nothing is live: judges get the real UI, the real incidents and the real AI reports,
// with no install, no keys and no server.
//   node build-demo.mjs [--seconds 200]     (an LLM key makes the AI reports real)
import fs from "node:fs";
import { spawn } from "node:child_process";
import { PAGE } from "./dashboard.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const SECONDS = Number(opt("--seconds", 200));
const PORT = 7799;
const MCP_PORT = 7798;

const cfg = JSON.parse(fs.readFileSync("config.demo.json", "utf8"));
cfg.mcp = { url: `http://127.0.0.1:${MCP_PORT}/mcp` };
cfg.dashboard = { port: PORT };
cfg.intervalSec = 3;
cfg.advisor = { everyTicks: 6 };
fs.writeFileSync(".demo-build.json", JSON.stringify(cfg));

const kids = [];
const run = (argv) => {
  const p = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "pipe"] });
  kids.push(p);
  return p;
};

const paper = run(["paper-mcp.mjs", "--http", String(MCP_PORT), "--replay", "2024-08-04T20:00:00Z", "--step", "15", "--tick", "3"]);
let perr = "";
paper.stderr.on("data", (d) => (perr += d));
for (let i = 0; i < 200 && !/replaying/.test(perr); i++) await new Promise((r) => setTimeout(r, 200));
if (!/replaying/.test(perr)) throw new Error("paper server did not start: " + perr);
run(["rogue-agent.mjs", "--url", `http://127.0.0.1:${MCP_PORT}/mcp`, "--every", "6"]);
run(["jaga.mjs", "--config", ".demo-build.json", "--state", ".demo-state.json", "--audit", ".demo-audit.jsonl"]);

// wait for the dashboard, then record the event stream exactly as a browser would see it
for (let i = 0; i < 150; i++) {
  try {
    await fetch(`http://127.0.0.1:${PORT}/healthz`);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}
console.log(`recording ${SECONDS}s of the real stack…`);
const events = [];
const t0 = Date.now();
const res = await fetch(`http://127.0.0.1:${PORT}/events`);
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
const done = new Promise((r) => setTimeout(r, SECONDS * 1000));
const pump = (async () => {
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) return;
    buf += dec.decode(value, { stream: true });
    for (const chunk of buf.split("\n\n")) {
      if (!chunk.startsWith("data: ")) continue;
      try {
        events.push({ at: Date.now() - t0, ev: JSON.parse(chunk.slice(6)) });
        process.stdout.write(`\r  ${events.length} events`);
      } catch {}
    }
    buf = buf.slice(buf.lastIndexOf("\n\n") + 2);
  }
})();
await Promise.race([done, pump]);
for (const k of kids) k.kill();
console.log(`\ncaptured ${events.length} events (${events.filter((e) => e.ev.type === "report").length} AI reports, ${events.filter((e) => e.ev.type === "action").length} executions)`);
if (events.filter((e) => e.ev.type === "tick").length < 5) throw new Error("too few ticks recorded — is the stack healthy?");

// Bake: the page's own script does `new EventSource("/events")`, so a stub class with the
// same shape replays the recording without touching a line of dashboard.mjs.
const banner = `<div style="background:#131824;border:1px solid #1f2937;border-left:3px solid #c084fc;border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:12px;color:#8b93a7">
📼 <b style="color:#e5e7eb">Recorded run, replaying in your browser.</b> This is the real Jaga stack — paper MCP server on Binance's actual Aug 4–5 2024 candles, a real rogue agent buying into ETH over MCP, real interventions, real AI reports — captured once and baked into this page. Nothing here is live and no order is real. Run it yourself: <a href="https://github.com/PugarHuda/jaga-agent" style="color:#60a5fa">github.com/PugarHuda/jaga-agent</a>
</div>`;
const stub = `<script>
// replay the recorded stream in place of SSE; the page code below is byte-identical to the live dashboard
const REPLAY=${JSON.stringify(events)};
window.EventSource=function(){const self=this;self.onopen=self.onerror=self.onmessage=null;
  setTimeout(()=>{self.onopen&&self.onopen()},0);
  const start=(offset)=>{for(const r of REPLAY)setTimeout(()=>{self.onmessage&&self.onmessage({data:JSON.stringify(r.ev)})},r.at+offset)};
  start(300);
  setInterval(()=>start(300),${Math.max(30000, events.at(-1)?.at ?? 60000) + 4000}); // loop so a late visitor still sees the crash
};
const realFetch=window.fetch.bind(window);
window.fetch=(u,o)=>String(u).startsWith("/panic")||String(u).startsWith("/decide")
  ? (alert("This is a recorded replay — the panic button and approvals only act on a live guard. Clone the repo to drive the real thing."),Promise.resolve(new Response("{}")))
  : realFetch(u,o);
</script>`;
const DOT = "●";
const html = PAGE.replace("__BOOT__", JSON.stringify({ series: [], events: [], actions: 0, lastTick: null, pending: [] }))
  .replace('<div style="display:flex;flex-wrap:wrap', banner + '<div style="display:flex;flex-wrap:wrap')
  .replace("<script>", stub + "<script>")
  // never claim "live" on a recording
  .replace(`<span id="dot" style="color:var(--green)">${DOT}</span> live`, `<span id="dot" style="color:var(--purple)">${DOT}</span> replay`)
  .replace("live guard</title>", "recorded run</title>");
fs.mkdirSync("public", { recursive: true });
fs.writeFileSync("public/index.html", html);
for (const f of [".demo-build.json", ".demo-state.json", ".demo-state.json.tmp", ".demo-audit.jsonl"]) fs.rmSync(f, { force: true });
console.log(`📦 public/index.html — ${(html.length / 1024).toFixed(0)} KB`);
