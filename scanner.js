import * as cheerio from "cheerio";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const trackerDb = JSON.parse(
  await readFile(join(__dirname, "data", "trackers.json"), "utf8")
).trackers;

const FETCH_TIMEOUT_MS = 12000;
const MAX_BYTES = 4 * 1024 * 1024; // 4MB cap

/** Normalize user input into a proper URL. */
export function normalizeUrl(input) {
  let raw = String(input || "").trim();
  if (!raw) throw new Error("No URL provided");
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
  const u = new URL(raw); // throws if invalid
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http/https URLs are supported");
  return u;
}

export function rootDomain(hostname) {
  const parts = hostname.split(".");
  return parts.length <= 2 ? hostname : parts.slice(-2).join(".");
}

/** Pull every external resource URL referenced in the HTML. */
function extractResourceHosts($, pageUrl) {
  const urls = new Set();
  const add = (val) => {
    if (!val) return;
    try {
      const u = new URL(val, pageUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") return; // skip data:, blob:, mailto:, etc.
      if (!u.hostname) return;
      urls.add(u.href);
    } catch { /* ignore malformed */ }
  };
  $("script[src]").each((_, el) => add($(el).attr("src")));
  $("img[src]").each((_, el) => add($(el).attr("src")));
  $("iframe[src]").each((_, el) => add($(el).attr("src")));
  $("link[href]").each((_, el) => add($(el).attr("href")));
  $("source[src]").each((_, el) => add($(el).attr("src")));
  return [...urls];
}

/** Detect forms and the kinds of personal data they ask FROM the user. */
function extractDataFromYou($) {
  const found = new Map(); // label -> example field
  const mark = (label, hint) => { if (!found.has(label)) found.set(label, hint); };

  $("input, textarea, select").each((_, el) => {
    const type = ($(el).attr("type") || "text").toLowerCase();
    const name = ($(el).attr("name") || "").toLowerCase();
    const id = ($(el).attr("id") || "").toLowerCase();
    const ac = ($(el).attr("autocomplete") || "").toLowerCase();
    const ph = ($(el).attr("placeholder") || "").toLowerCase();
    const hay = `${name} ${id} ${ac} ${ph}`;

    if (type === "email" || /email|e-mail/.test(hay)) mark("Email address", "email field");
    if (type === "password") mark("Password", "password field");
    if (type === "tel" || /phone|mobile|tel/.test(hay)) mark("Phone number", "phone field");
    if (/\bname\b|fname|lname|first-?name|last-?name|fullname/.test(hay)) mark("Name", "name field");
    if (/address|street|city|zip|postal|state/.test(hay)) mark("Postal address", "address field");
    if (/card|cc-|credit|cvv|cvc|payment/.test(hay) || ac.includes("cc-")) mark("Payment / card details", "payment field");
    if (/dob|birth|bday/.test(hay)) mark("Date of birth", "birthday field");
    if (/company|organization|org\b/.test(hay)) mark("Company / employer", "company field");
    if (type === "search" || /\bsearch\b|\bquery\b/.test(hay)) mark("Search queries", "search field");
    if (type === "file") mark("Uploaded files", "file upload");
  });

  return [...found.entries()].map(([label, hint]) => ({ label, hint }));
}

/** Classify third-party hosts against the tracker database. */
export function classifyTrackers(resourceUrls, pageHost) {
  const pageRoot = rootDomain(pageHost);
  const thirdParty = new Map();   // host -> {host, firstParty:false}
  const identified = new Map();   // key -> tracker record + sample host

  for (const href of resourceUrls) {
    let host;
    try { host = new URL(href).hostname; } catch { continue; }
    const isFirstParty = rootDomain(host) === pageRoot;

    const hit = trackerDb.find((t) => href.toLowerCase().includes(t.match));
    if (hit) {
      const key = hit.owner + "|" + hit.category + "|" + hit.collects;
      if (!identified.has(key)) identified.set(key, { ...hit, sample: host });
    } else if (!isFirstParty) {
      if (!thirdParty.has(host)) thirdParty.set(host, host);
    }
  }
  return {
    knownTrackers: [...identified.values()],
    otherThirdParty: [...thirdParty.keys()],
  };
}

/** Parse Set-Cookie response headers. */
function parseCookies(headers) {
  const cookies = [];
  // Node fetch merges multiple Set-Cookie via getSetCookie() when available.
  const raw = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : (headers.get("set-cookie") ? [headers.get("set-cookie")] : []);
  for (const line of raw) {
    const [pair] = line.split(";");
    const name = (pair.split("=")[0] || "").trim();
    if (name) {
      const persistent = /max-age|expires/i.test(line);
      cookies.push({ name, persistent });
    }
  }
  return cookies;
}

/** Compute a rough privacy score (higher = better). */
export function scoreResult(r) {
  let score = 100;
  score -= r.knownTrackers.filter((t) => t.category === "advertising").length * 10;
  score -= r.knownTrackers.filter((t) => t.category === "session-replay").length * 12;
  score -= r.knownTrackers.filter((t) => ["analytics", "marketing", "ab-testing"].includes(t.category)).length * 5;
  score -= r.otherThirdParty.length * 1.5;
  score -= r.cookies.filter((c) => c.persistent).length * 2;
  score -= r.dataFromYou.filter((d) => /Payment|Password/.test(d.label)).length * 3;
  score -= (r.fingerprinting?.length || 0) * 6;
  score -= (r.storageKeys?.length || 0) * 0.5;
  return Math.max(3, Math.min(100, Math.round(score)));
}

export async function scanUrl(input) {
  const url = normalizeUrl(input);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url.href, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; PrivacyLens/1.0; +https://github.com/)",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
  } catch (err) {
    clearTimeout(timer);
    const reason = err.name === "AbortError" ? "The site took too long to respond." : err.message;
    throw new Error(`Could not fetch ${url.hostname}: ${reason}`);
  }
  clearTimeout(timer);

  const cookies = parseCookies(res.headers);
  const server = res.headers.get("server") || null;

  // Read body with a size cap.
  const reader = res.body?.getReader?.();
  let html = "";
  if (reader) {
    const decoder = new TextDecoder();
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      html += decoder.decode(value, { stream: true });
      if (bytes > MAX_BYTES) { try { await reader.cancel(); } catch {} break; }
    }
  } else {
    html = await res.text();
  }

  const $ = cheerio.load(html);
  const resourceUrls = extractResourceHosts($, url.href);
  const { knownTrackers, otherThirdParty } = classifyTrackers(resourceUrls, url.hostname);
  const dataFromYou = extractDataFromYou($);

  // Inline pixel/beacon signatures the DOM parse can miss.
  const lowerHtml = html.toLowerCase();
  const inlineSignals = [];
  if (/gtag\(|googletagmanager/.test(lowerHtml)) inlineSignals.push("Google Analytics / GA4 (inline)");
  if (/fbq\(|facebook pixel/.test(lowerHtml)) inlineSignals.push("Meta Pixel (inline)");
  if (/ttq\.|tiktok pixel/.test(lowerHtml)) inlineSignals.push("TikTok Pixel (inline)");

  const result = {
    url: url.href,
    domain: url.hostname,
    scannedAt: new Date().toISOString(),
    server,
    status: res.status,
    knownTrackers,
    otherThirdParty,
    cookies,
    dataFromYou,
    inlineSignals,
    resourceCount: resourceUrls.length,
  };
  result.privacyScore = scoreResult(result);
  return result;
}
