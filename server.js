import express from "express";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scanUrl, normalizeUrl } from "./scanner.js";
import { deepScan } from "./deepscan.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(join(__dirname, "public")));

/** Block requests that resolve to private / internal ranges (SSRF guard). */
function isPrivateAddress(ip) {
  if (isIP(ip) === 6) {
    const l = ip.toLowerCase();
    return l === "::1" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80") || l.startsWith("::ffff:");
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast/reserved
  );
}

async function assertPublicHost(hostname) {
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error("Refusing to scan a private/internal address.");
    return;
  }
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".local") || lower.endsWith(".internal")) {
    throw new Error("Refusing to scan a local/internal host.");
  }
  const records = await lookup(hostname, { all: true });
  if (!records.length) throw new Error("Host did not resolve.");
  if (records.some((r) => isPrivateAddress(r.address))) {
    throw new Error("Host resolves to a private/internal address.");
  }
}

app.get("/api/scan", async (req, res) => {
  const started = Date.now();
  // Deep (headless-browser) scan is the default; pass ?mode=fast for the quick static scan.
  const deep = req.query.mode !== "fast";
  try {
    const url = normalizeUrl(req.query.url);
    await assertPublicHost(url.hostname);
    let result;
    if (deep) {
      try {
        result = await deepScan(url.href);
      } catch (err) {
        // Headless browser failed (e.g. site blocked it) — fall back to the static scan.
        result = await scanUrl(url.href);
        result.mode = "fast";
        result.degraded = `Deep scan failed (${err.message}); showing static-scan results.`;
      }
    } else {
      result = await scanUrl(url.href);
      result.mode = "fast";
    }
    if (result.tookMs == null) result.tookMs = Date.now() - started;
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Privacy Lens running on http://localhost:${PORT}`);
});
