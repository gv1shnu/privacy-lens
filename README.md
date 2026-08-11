# Privacy Lens

Enter any website and get an **organized, real-time report** of what data it collects
**about you** (third-party trackers, cookies, ad/analytics pixels, and active device
fingerprinting) and **from you** (the personal data its forms ask you to type in).

Built as an educational project on **data privacy** and **DBMS** concepts: a curated
tracker database is queried and joined against everything a live page loads and does.

## Two scan modes

| Mode | How | What it sees |
|------|-----|--------------|
| **Deep scan** (default) | Loads the page in a real headless **Chromium** (Puppeteer) and watches it run | Every network request, cookies set by JavaScript, localStorage/sessionStorage, and **fingerprinting APIs the site actively calls** (canvas, WebGL, audio, WebRTC local-IP, CPU/RAM/plugin probing) |
| **Fast scan** (`?mode=fast`) | Server-side `fetch` + HTML parse | Trackers referenced in the initial HTML, response cookies, forms |

Deep scan is far more accurate because most trackers load *after* the initial HTML via
JavaScript — a static fetch never sees them. Example: `cnn.com` shows ~4 trackers on a
fast scan vs. **11 trackers, 235 third-party hosts, 53 cookies, and 8 fingerprinting
probes** on a deep scan.

### Why it needs a backend (not GitHub Pages)

A browser's **same-origin policy** stops client-side JS from reading another site's
response, and a headless browser can't run in a static page at all. So the scan runs
**server-side**. That's why this deploys to **Railway / Render**, not GitHub Pages.

## How it works

```
Browser ──/api/scan?url=──► Express ──► deep scan (Puppeteer headless Chromium)
                                │            ├─ record every network request
                                │            ├─ hook fingerprinting APIs before page JS runs
                                │            ├─ read cookies + localStorage after JS runs
                                │            └─ read data-collecting form fields
                                │        (falls back to a fast static scan if the browser fails)
                                │
                                ├─ classify hosts against data/trackers.json  (the "DB")
                                └─ compute a 0–100 privacy score
                                │
Browser ◄──── organized JSON report, grouped by category
```

- **`deepscan.js`** — headless-browser scan (fingerprinting, full request trace, storage).
- **`scanner.js`** — fast static scan + shared tracker classification & scoring.
- **`server.js`** — Express API, static hosting, and an **SSRF guard** (refuses localhost / private IPs).
- **`data/trackers.json`** — the tracker "database" (host pattern → owner + purpose).
- **`public/`** — the search UI.

## Run locally

```bash
npm install       # also downloads Chromium into ./.cache/puppeteer
npm start
# open http://localhost:3000
```

## Deploy (Docker — recommended for both platforms)

Puppeteer needs Chromium + system libraries, which the plain Node buildpacks don't
reliably provide. The included **`Dockerfile`** handles this.

### Railway
1. Push this repo to GitHub.
2. Railway → **New Project → Deploy from GitHub repo**. It detects the `Dockerfile` and builds it.
3. Railway injects `PORT` automatically. Done.

### Render
1. Push this repo to GitHub.
2. Render → **New → Web Service** → pick the repo → **Runtime: Docker**. It uses the `Dockerfile`.

> Deep scans are memory-hungry (a full Chromium). On free tiers, prefer scanning one
> site at a time; if you hit out-of-memory, the app still falls back to the fast scan.

## Notes & limits

- Some sites block automated browsers (bot walls, CAPTCHAs) or gate content behind
  consent — results for those will be partial. The UI reports this cleanly.
- Deep scan waits for network to settle (up to ~25s) then a short buffer, so a heavy
  ad-funded site can take 30–40s. The toggle warns the user.
- Results are **best-effort and educational**, not a legal privacy audit.

## Screenshots

<img width="1888" height="1432" alt="image" src="https://github.com/user-attachments/assets/e5ec63c4-49fc-43ba-a176-dbe2053bbb1e" />

