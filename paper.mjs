// `npm run paper`: one wallet, one real market, two agents.
//   1. paper-mcp.mjs --http 7788   shared paper subaccount on live Binance data
//   2. rogue-agent.mjs             compromised trader buying into ETH over MCP
//   3. jaga.mjs                    the guardian, over the same MCP endpoint
// Ctrl+C stops all three. Pass --llm to make the rogue agent LLM-driven.
import { spawn } from "node:child_process";

const extra = process.argv.slice(2);
const kids = [];
const run = (label, args) => {
  const p = spawn(process.execPath, args, { stdio: ["ignore", "inherit", "inherit"], env: process.env });
  kids.push(p);
  p.on("exit", (code) => {
    if (code && code !== 0) console.error(`${label} exited with ${code}`);
  });
  return p;
};
const waitFor = (url, ms = 15000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = () =>
      fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" })
        .then(() => resolve())
        .catch(() => (Date.now() - t0 > ms ? reject(new Error("paper MCP did not start")) : setTimeout(poll, 300)));
    poll();
  });

run("paper-mcp", ["paper-mcp.mjs", "--http", "7788"]);
await waitFor("http://127.0.0.1:7788/mcp");
run("rogue-agent", ["rogue-agent.mjs", "--url", "http://127.0.0.1:7788/mcp", "--every", "20", ...extra.filter((a) => a === "--llm")]);
run("jaga", ["jaga.mjs", "--config", "config.paper.json"]);

const stop = () => {
  for (const k of kids) k.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
