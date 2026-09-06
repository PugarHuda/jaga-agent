// One wallet, one real market, two agents.
//   npm run paper   →  node paper.mjs                       live Binance stream
//   npm run demo    →  node paper.mjs --replay 2024-08-04T20:00:00Z --step 15 --config config.demo.json
//                                                          real historical crash, replayed
//   1. paper-mcp.mjs --http 7788   shared paper subaccount (live or replay)
//   2. rogue-agent.mjs             compromised trader buying into ETH over MCP
//   3. jaga.mjs                    the guardian, over the same MCP endpoint
// Ctrl+C stops all three. --llm makes the rogue agent LLM-driven.
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const CONFIG = opt("--config", "config.paper.json");
const PORT = opt("--port", "7788");
const replayArgs = args.includes("--replay") ? ["--replay", opt("--replay"), "--step", opt("--step", "15"), "--hours", opt("--hours", "12")] : [];

const kids = [];
const run = (label, a) => {
  const p = spawn(process.execPath, a, { stdio: ["ignore", "inherit", "inherit"], env: process.env });
  kids.push(p);
  p.on("exit", (code) => {
    if (code && code !== 0) console.error(`${label} exited with ${code}`);
  });
  return p;
};
const waitFor = (url, ms = 30000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = () =>
      fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" })
        .then(() => resolve())
        .catch(() => (Date.now() - t0 > ms ? reject(new Error("paper MCP did not start")) : setTimeout(poll, 300)));
    poll();
  });

run("paper-mcp", ["paper-mcp.mjs", "--http", PORT, ...replayArgs]);
await waitFor(`http://127.0.0.1:${PORT}/mcp`);
run("rogue-agent", ["rogue-agent.mjs", "--url", `http://127.0.0.1:${PORT}/mcp`, "--every", opt("--rogue-every", "20"), ...(args.includes("--llm") ? ["--llm"] : [])]);
run("jaga", ["jaga.mjs", "--config", CONFIG]);

const stop = () => {
  for (const k of kids) k.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
