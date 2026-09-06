// End-to-end dashboard QA with Playwright: boots Jaga in PROPOSE mode against the
// mock market with a rogue agent, drives the real browser UI, and checks the
// human-in-the-loop path: proposal appears → Approve executes through MCP →
// Reject records a rejection → CSRF guard holds → /mcp answers other agents.
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jaga-e2e-"));
const cfgPath = path.join(dir, "config.json");
const statePath = path.join(dir, "state.json");
const auditPath = path.join(dir, "audit.jsonl");
const cfg = JSON.parse(fs.readFileSync("config.demo.json", "utf8"));
cfg.rules.mode = "propose";
cfg.intervalSec = 1;
cfg.dashboard.port = PORT;
cfg.advisor = { everyTicks: 0 };
fs.writeFileSync(cfgPath, JSON.stringify(cfg));

let checks = 0;
const ok = (c, m) => {
  assert.ok(c, m);
  checks++;
};

const jaga = spawn(process.execPath, ["jaga.mjs", "--config", cfgPath, "--state", statePath, "--audit", auditPath], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, OPENROUTER_API_KEY: "", LLM_API_KEY: "", VENICE_API_KEY: "" } });
let out = "";
jaga.stdout.on("data", (d) => (out += d));
jaga.stderr.on("data", (d) => (out += d));

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

  // the rogue agent concentrates ETH → engine proposes a trim → dashboard shows Approve/Reject
  const approve = page.getByRole("button", { name: "✅ Approve" }).first();
  await approve.waitFor({ state: "visible", timeout: 30000 });
  ok(true, "proposal card appears with approval buttons");
  ok(/max-position/.test(out), "engine reported the concentration breach");
  ok(!/EXECUTED/.test(out), "nothing executed before human approval");

  // approve → order goes through MCP → executed event → pending card clears
  await approve.click();
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

  // the guardian is itself an MCP server other agents can query
  const mcp = new Client({ name: "e2e", version: "1" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));
  const status = (await mcp.callTool({ name: "risk_status", arguments: {} })).structuredContent;
  ok(status.mode === "propose" && typeof status.total === "number" && Array.isArray(status.positions), "risk_status over MCP");
  const tail = (await mcp.callTool({ name: "audit_tail", arguments: { n: 5 } })).structuredContent.items;
  ok(tail.length === 5 && tail.every((e) => e.hash && "prev" in e), "audit_tail over MCP is hash-chained");
  await mcp.close();

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
  fs.rmSync(dir, { recursive: true, force: true });
}
