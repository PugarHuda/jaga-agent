// End-to-end QA with Playwright on the REAL stack: paper MCP server replaying real
// Binance history (Aug 2024 crash), a real rogue MCP client, Jaga in PROPOSE mode.
// Drives the browser UI and checks the human-in-the-loop path: proposal appears →
// Approve executes through MCP → Reject records a rejection → panic, hot reload,
// metrics, health, alerts, CSRF guard, /mcp tools+resources+prompts, restart.
// Run: npm run test:e2e   (needs Chromium: `npx playwright install chromium`
// or set CHROME_PATH to an existing Chrome/Chromium binary)
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { verifyAudit } from "./audit-verify.mjs";

const PORT = 7791;
const MCP_PORT = 7792;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jaga-e2e-"));
const cfgPath = path.join(dir, "config.json");
const statePath = path.join(dir, "state.json");
const auditPath = path.join(dir, "audit.jsonl");
const cfg = JSON.parse(fs.readFileSync("config.demo.json", "utf8"));
cfg.mcp = { url: `http://127.0.0.1:${MCP_PORT}/mcp` };
cfg.rules.mode = "propose";
cfg.intervalSec = 1;
cfg.dashboard.port = PORT;
cfg.advisor = { everyTicks: 0 };

// a real HTTP receiver for webhook alerts — the alert path is verified end to end
import http from "node:http";
const alerts = [];
const hook = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    alerts.push(JSON.parse(b));
    res.writeHead(204).end();
  });
});
await new Promise((r) => hook.listen(0, "127.0.0.1", r));
cfg.alerts = { webhook: `http://127.0.0.1:${hook.address().port}/hook` };
fs.writeFileSync(cfgPath, JSON.stringify(cfg));

let checks = 0;
const ok = (c, m) => {
  assert.ok(c, m);
  checks++;
};

// the real paper server in replay mode + the real rogue agent, both over HTTP MCP
const paper = spawn(process.execPath, ["paper-mcp.mjs", "--http", String(MCP_PORT), "--replay", "2024-08-04T20:00:00Z", "--step", "10"], { stdio: ["ignore", "ignore", "pipe"] });
let paperErr = "";
paper.stderr.on("data", (d) => (paperErr += d));
for (let i = 0; i < 150 && !/paper MCP/.test(paperErr); i++) await new Promise((r) => setTimeout(r, 200));
if (!/paper MCP/.test(paperErr)) throw new Error("paper-mcp did not start: " + paperErr);
const rogue = spawn(process.execPath, ["rogue-agent.mjs", "--url", `http://127.0.0.1:${MCP_PORT}/mcp`, "--every", "4"], { stdio: ["ignore", "ignore", "ignore"] });

let out = "";
const spawnJaga = () => {
  const p = spawn(process.execPath, ["jaga.mjs", "--config", cfgPath, "--state", statePath, "--audit", auditPath], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, OPENROUTER_API_KEY: "", LLM_API_KEY: "", VENICE_API_KEY: "" } });
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  return p;
};
let jaga = spawnJaga();

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
try {
  const t0 = Date.now();
  while (!/dashboard →/.test(out)) {
    if (Date.now() - t0 > 15000) throw new Error("jaga did not start:\n" + out);
    await new Promise((r) => setTimeout(r, 200));
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}`);

  // live data lands on first paint (boot-injected) and keeps updating over SSE
  await page.waitForFunction(() => document.getElementById("total").textContent.includes("USDC"), null, { timeout: 10000 });
  ok(true, "first paint shows a live portfolio total");
  await page.waitForFunction(() => document.getElementById("mode").textContent === "propose");
  ok(true, "mode card reflects config");
  ok((await page.locator("#dd").textContent()).includes("/ " + cfg.rules.maxDrawdownPct + "%"), "drawdown card shows the configured limit");
  await page.waitForFunction(() => [...document.querySelectorAll("#pos td:nth-child(4)")].some((td) => /%$/.test(td.textContent)), null, { timeout: 10000 });
  ok(true, "positions show unrealized PnL vs cost basis");

  // the rogue agent concentrates ETH → engine proposes a trim → dashboard shows Approve/Reject
  const approve = page.getByRole("button", { name: "✅ Approve" }).first();
  await approve.waitFor({ state: "visible", timeout: 30000 });
  ok(true, "proposal card appears with approval buttons");
  ok(/max-position/.test(out), "engine reported the concentration breach");
  ok(!/EXECUTED/.test(out), "nothing executed before human approval");

  // approve via keyboard (a11y) → order goes through MCP → executed event → pending card clears
  await approve.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => [...document.querySelectorAll("#feed .badge")].some((b) => b.textContent === "executed"), null, { timeout: 10000 });
  ok(true, "approval executed the trim through MCP and the feed shows it");
  await page.waitForFunction(() => document.getElementById("pendingCard").style.display === "none", null, { timeout: 5000 });
  ok(true, "pending card clears after the decision");
  ok(Number(await page.locator("#acts").textContent()) >= 1, "interventions counter incremented");

  // next proposal → reject → recorded, nothing executed for it
  const reject = page.getByRole("button", { name: "❌ Reject" }).first();
  await reject.waitFor({ state: "visible", timeout: 60000 });
  const executedBefore = (out.match(/EXECUTED/g) || []).length;
  await reject.click();
  await page.waitForFunction(() => [...document.querySelectorAll("#feed .badge")].some((b) => b.textContent === "rejected"), null, { timeout: 10000 });
  ok(true, "rejection shows in the feed");
  await new Promise((r) => setTimeout(r, 1500));
  ok((out.match(/EXECUTED/g) || []).length === executedBefore, "rejected proposal was not executed");

  // CSRF: a cross-origin JSON POST is refused; a wrong content-type is refused
  const csrf = await page.evaluate(async (port) => {
    const a = await fetch("/decide", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }).then((r) => r.status);
    return a;
  }, PORT);
  ok(csrf === 415, "non-JSON POST to /decide rejected (415)");
  const evil = await browser.newPage();
  await evil.setContent(`<script>window.r = fetch("http://localhost:${PORT}/decide",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}).then(r=>r.status).catch(()=>"blocked")</script>`);
  ok(["blocked", 403].includes(await evil.evaluate(() => window.r)), "cross-origin approval blocked (CORS/403)");

  // the webhook alert for the approved intervention reached a real HTTP receiver
  for (let i = 0; i < 50 && !alerts.length; i++) await new Promise((r) => setTimeout(r, 200));
  ok(alerts.some((a) => /Jaga intervention/.test(a.content) && /max-position/.test(a.text)), "webhook alert delivered with the incident report");

  // health endpoint
  const health = await page.evaluate(() => fetch("/healthz").then((r) => r.json()));
  ok(health.ok === true && health.lastTickAgeSec <= 3 && health.mode === "propose" && health.interventions >= 1, "/healthz reports a live, ticking guard");

  // Prometheus metrics reflect live state
  const metrics = await page.evaluate(() => fetch("/metrics").then((r) => r.text()));
  ok(/^jaga_portfolio_total \d/m.test(metrics) && /jaga_interventions_total 1\b/.test(metrics), "/metrics exposes portfolio + intervention counters");

  // hot reload: tighten the concentration cap on disk → dashboard shows the new limit, feed logs it
  cfg.rules.maxPositionPct = 30;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  await page.waitForFunction(() => document.getElementById("pos").textContent.includes("/ 30%"), null, { timeout: 15000 });
  ok(/rules reloaded/.test(out), "config change picked up without restart");
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, rules: { ...cfg.rules, mode: "yolo" } }));
  await page.waitForFunction(() => [...document.querySelectorAll("#feed .badge")].some((b) => b.textContent === "config-rejected"), null, { timeout: 15000 });
  ok(/config change rejected/.test(out), "invalid config edit rejected, old rules kept");
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));

  // panic button: confirm dialog → every position sold to quote, regardless of propose mode
  page.once("dialog", (d) => d.accept());
  const executedBeforePanic = (out.match(/EXECUTED/g) || []).length;
  await page.getByRole("button", { name: "🚨 De-risk everything" }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("#feed .badge")].some((b) => b.textContent === "🚨 panic"), null, { timeout: 10000 });
  // wait until the audit shows a FILLED full sell for every target the panic entry named
  let panicEntry, panicSells = [];
  for (let i = 0; i < 100; i++) {
    const auditNow = fs.readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const idx = auditNow.findIndex((e) => e.type === "panic");
    panicEntry = idx >= 0 ? auditNow[idx] : null;
    panicSells = idx >= 0 ? auditNow.slice(idx + 1).filter((e) => e.type === "action" && e.full && e.status === "FILLED") : [];
    if (panicEntry && panicSells.length >= panicEntry.positions.length) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  ok(/PANIC: human-triggered/.test(out) && (out.match(/EXECUTED/g) || []).length > executedBeforePanic, "panic liquidated positions through MCP");
  ok(panicEntry && panicSells.length >= panicEntry.positions.length, `audit shows one FILLED full sell per panic target (${panicSells.length}/${panicEntry?.positions.length})`);

  // the guardian is itself an MCP server other agents can query
  const mcp = new Client({ name: "e2e", version: "1" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));
  const status = (await mcp.callTool({ name: "risk_status", arguments: {} })).structuredContent;
  ok(status.mode === "propose" && typeof status.total === "number" && Array.isArray(status.positions), "risk_status over MCP");
  const tail = (await mcp.callTool({ name: "audit_tail", arguments: { n: 5 } })).structuredContent.items;
  ok(tail.length === 5 && tail.every((e) => e.hash && "prev" in e), "audit_tail over MCP is hash-chained");
  const resources = (await mcp.listResources()).resources.map((r) => r.uri);
  ok(resources.includes("jaga://audit"), "audit trail published as an MCP resource");
  const res = await mcp.readResource({ uri: "jaga://audit" });
  ok(res.contents[0].text.split("\n").every((l) => JSON.parse(l).hash), "resource body is the JSONL chain");
  ok((await mcp.listPrompts()).prompts.some((p) => p.name === "incident_briefing"), "incident_briefing prompt advertised");
  const briefing = await mcp.getPrompt({ name: "incident_briefing", arguments: {} });
  ok(/max-position/.test(briefing.messages[0].content.text) && /Mode: propose/.test(briefing.messages[0].content.text), "prompt carries the real recent incidents and mode");
  await mcp.close();
  await page.screenshot({ path: "e2e-dashboard.png" });

  // restart resilience: kill Jaga, bring it back on the same port → the open dashboard
  // reconnects, reloads, and the equity curve is replayed from the audit trail
  const seriesBefore = await page.evaluate(() => series.length);
  jaga.kill();
  await new Promise((r) => setTimeout(r, 1500));
  const navigated = page.waitForNavigation({ timeout: 30000 });
  jaga = spawnJaga();
  await navigated;
  await page.waitForFunction(() => document.getElementById("total").textContent.includes("USDC"), null, { timeout: 15000 });
  ok(await page.evaluate(() => series.length) >= Math.min(seriesBefore, 5), "equity curve survived the restart (replayed from audit)");
  const starts = fs.readFileSync(auditPath, "utf8").split("\n").filter((l) => l.includes('"type":"start"')).length;
  ok(starts === 2, "both process starts recorded in the audit chain");
  ok((await page.evaluate(() => document.getElementById("dot").style.color)) === "var(--green)", "SSE reconnected after restart");

  // audit trail on disk verifies end to end
  const v = verifyAudit(auditPath);
  ok(v.ok && v.entries > 10, `audit chain intact (${v.entries} entries)`);
  ok(errors.length === 0, "no browser errors: " + errors.join("; "));

  // responsive: narrow viewport stacks the columns, no horizontal scroll
  await page.setViewportSize({ width: 420, height: 800 });
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no horizontal overflow on mobile width");

  console.log(`✅ all ${checks} e2e checks passed`);
} finally {
  await browser.close();
  jaga.kill();
  rogue.kill();
  paper.kill();
  hook.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
