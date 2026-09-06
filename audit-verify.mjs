// Verify the audit trail's SHA-256 hash chain. Any edited, deleted or
// reordered line breaks the chain from that point on. Run: npm run audit:verify
import fs from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export function verifyAudit(path = "audit.jsonl") {
  const lines = fs.readFileSync(path, "utf8").split("\n").filter(Boolean);
  let prev = "";
  for (let i = 0; i < lines.length; i++) {
    const rec = JSON.parse(lines[i]);
    const { hash, ...rest } = rec;
    if (rest.prev !== prev) return { ok: false, line: i + 1, reason: "broken link to previous entry" };
    const want = createHash("sha256").update(JSON.stringify(rest)).digest("hex");
    if (hash !== want) return { ok: false, line: i + 1, reason: "hash mismatch (entry modified)" };
    prev = hash;
  }
  return { ok: true, entries: lines.length, head: prev };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const r = verifyAudit(process.argv[2] ?? "audit.jsonl");
  console.log(r.ok ? `✅ audit chain intact: ${r.entries} entries, head ${r.head.slice(0, 12)}…` : `❌ audit chain BROKEN at line ${r.line}: ${r.reason}`);
  process.exit(r.ok ? 0 : 1);
}
