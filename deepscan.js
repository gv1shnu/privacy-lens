import puppeteer from "puppeteer";
import { normalizeUrl, classifyTrackers, scoreResult } from "./scanner.js";

const NAV_TIMEOUT_MS = 25000;
const SETTLE_MS = 2500; // let late-firing trackers/pixels run after load

/**
 * Injected into the page BEFORE any site code runs. It wraps the browser APIs
 * commonly used for device fingerprinting and records which ones the site calls,
 * so we can report what the site actively learns about the visitor in real time.
 */
function fingerprintProbe() {
  window.__pl = { fp: new Set(), env: {} };
  const mark = (label) => window.__pl.fp.add(label);
  const wrap = (obj, name, label) => {
    try {
      const orig = obj[name];
      if (typeof orig !== "function") return;
      obj[name] = function (...args) { mark(label); return orig.apply(this, args); };
    } catch {}
  };
  const getter = (proto, name, label) => {
    try {
      const d = Object.getOwnPropertyDescriptor(proto, name);
      if (!d || !d.get) return;
      Object.defineProperty(proto, name, { ...d, get() { mark(label); return d.get.call(this); } });
    } catch {}
  };

  // Canvas fingerprinting
  wrap(HTMLCanvasElement.prototype, "toDataURL", "Canvas image fingerprint");
  wrap(HTMLCanvasElement.prototype, "toBlob", "Canvas image fingerprint");
  wrap(CanvasRenderingContext2D.prototype, "getImageData", "Canvas pixel readback");
  // WebGL (GPU) fingerprinting
  if (window.WebGLRenderingContext) wrap(WebGLRenderingContext.prototype, "getParameter", "WebGL / GPU fingerprint");
  if (window.WebGL2RenderingContext) wrap(WebGL2RenderingContext.prototype, "getParameter", "WebGL / GPU fingerprint");
  // Audio fingerprinting
  if (window.OfflineAudioContext) wrap(OfflineAudioContext.prototype, "createDynamicsCompressor", "Audio fingerprint");
  if (window.AudioContext) wrap(AudioContext.prototype, "createOscillator", "Audio fingerprint");
  // Device / hardware probing
  getter(Navigator.prototype, "hardwareConcurrency", "CPU core count");
  getter(Navigator.prototype, "deviceMemory", "Device memory size");
  getter(Navigator.prototype, "platform", "OS platform");
  getter(Navigator.prototype, "plugins", "Installed plugins");
  getter(Navigator.prototype, "languages", "Language list");
  getter(Screen.prototype, "width", "Screen resolution");
  getter(Screen.prototype, "height", "Screen resolution");
  getter(Screen.prototype, "colorDepth", "Screen color depth");
  // Sensitive capabilities
  wrap(Navigator.prototype, "getBattery", "Battery status");
  if (navigator.permissions) wrap(navigator.permissions, "query", "Permission probing");
  if (navigator.geolocation) wrap(navigator.geolocation, "getCurrentPosition", "Geolocation request");
  if (window.RTCPeerConnection) wrap(window.RTCPeerConnection.prototype, "createDataChannel", "WebRTC (local IP) probe");
  wrap(window, "requestIdleCallback", "__noop"); // touch to keep list stable (ignored below)

  // Passive environment the site can read for free (not "probing", but worth showing)
  try {
    window.__pl.env = {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      language: navigator.language,
      screen: `${screen.width}x${screen.height}`,
      viewport: `${innerWidth}x${innerHeight}`,
      platform: navigator.platform,
    };
  } catch {}
}

/** Read data-collecting form fields from inside the live DOM. */
function extractFormsInPage() {
  const found = new Map();
  const mark = (label, hint) => { if (!found.has(label)) found.set(label, hint); };
  document.querySelectorAll("input, textarea, select").forEach((el) => {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    const hay = [el.name, el.id, el.autocomplete, el.placeholder].join(" ").toLowerCase();
    if (type === "email" || /email|e-mail/.test(hay)) mark("Email address", "email field");
    if (type === "password") mark("Password", "password field");
    if (type === "tel" || /phone|mobile|tel/.test(hay)) mark("Phone number", "phone field");
    if (/\bname\b|fname|lname|first-?name|last-?name|fullname/.test(hay)) mark("Name", "name field");
    if (/address|street|city|zip|postal/.test(hay)) mark("Postal address", "address field");
    if (/card|cc-|credit|cvv|cvc|payment/.test(hay)) mark("Payment / card details", "payment field");
    if (/dob|birth|bday/.test(hay)) mark("Date of birth", "birthday field");
    if (type === "search" || /\bsearch\b|\bquery\b/.test(hay)) mark("Search queries", "search field");
    if (type === "file") mark("Uploaded files", "file upload");
  });
  return [...found.entries()].map(([label, hint]) => ({ label, hint }));
}

export async function deepScan(input) {
  const url = normalizeUrl(input);
  const started = Date.now();

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    await page.evaluateOnNewDocument(fingerprintProbe);

    const requestUrls = [];
    page.on("request", (req) => requestUrls.push(req.url()));

    // Capture the main document's HTTP status even if navigation later times out
    // waiting for the (often never-idle) ad network traffic to settle.
    let status = 0;
    page.on("response", (resp) => {
      if (!status && resp.url() === url.href && resp.request().resourceType() === "document") {
        status = resp.status();
      }
    });

    try {
      const resp = await page.goto(url.href, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });
      if (resp) status = resp.status();
    } catch (err) {
      // Even on timeout we keep whatever loaded so far.
      if (!requestUrls.length) throw new Error(`Could not load ${url.hostname}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    // Everything the page actively did / stored.
    const probe = await page.evaluate(() => ({
      fp: Array.from((window.__pl && window.__pl.fp) || []).filter((x) => x !== "__noop"),
      env: (window.__pl && window.__pl.env) || {},
      localStorage: Object.keys(window.localStorage || {}),
      sessionStorage: Object.keys(window.sessionStorage || {}),
    }));
    const dataFromYou = await page.evaluate(extractFormsInPage);
    const cookies = (await page.cookies()).map((c) => ({
      name: c.name,
      persistent: c.expires > 0,
      thirdParty: !c.domain.replace(/^\./, "").endsWith(url.hostname.split(".").slice(-2).join(".")),
      httpOnly: c.httpOnly,
    }));

    const { knownTrackers, otherThirdParty } = classifyTrackers(requestUrls, url.hostname);

    const result = {
      mode: "deep",
      url: url.href,
      domain: url.hostname,
      scannedAt: new Date().toISOString(),
      status,
      knownTrackers,
      otherThirdParty,
      cookies,
      dataFromYou,
      fingerprinting: probe.fp,
      environment: probe.env,
      storageKeys: [...probe.localStorage, ...probe.sessionStorage],
      requestCount: requestUrls.length,
      resourceCount: requestUrls.length,
      inlineSignals: [],
      tookMs: Date.now() - started,
    };
    result.privacyScore = scoreResult(result);
    return result;
  } finally {
    await browser.close();
  }
}
