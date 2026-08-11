const form = document.getElementById("searchForm");
const input = document.getElementById("searchInput");
const deepToggle = document.getElementById("deepToggle");
const results = document.getElementById("results");

const CAT_LABELS = {
  advertising: "Advertising / retargeting",
  "session-replay": "Session recording",
  analytics: "Analytics",
  marketing: "Marketing",
  "ab-testing": "A/B testing",
  performance: "Performance / errors",
  security: "Security",
  consent: "Consent management",
  cdn: "CDN / assets",
};

form.addEventListener("submit", (e) => {
  e.preventDefault();
  run(input.value);
});

document.querySelectorAll(".chip").forEach((chip) =>
  chip.addEventListener("click", () => {
    input.value = chip.dataset.q;
    run(chip.dataset.q);
  })
);

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function message(html) {
  results.innerHTML = "";
  results.append(el("section", "card message", html));
}

async function run(value) {
  const q = (value || "").trim();
  if (!q) return;
  const deep = deepToggle.checked;
  message(
    `<p class="loading">Scanning <strong>${esc(q)}</strong>…</p>
     <p class="loading-sub">${deep ? "Deep scan — loading the page in a real browser and watching what it does. This can take 15–40 seconds." : "Static scan — reading the initial HTML."}</p>
     <div class="spinner"></div>`
  );
  try {
    const r = await fetch(`/api/scan?url=${encodeURIComponent(q)}${deep ? "" : "&mode=fast"}`);
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || "Scan failed");
    render(data.result);
  } catch (err) {
    message(
      `<p><strong>Couldn't scan that site.</strong></p>
       <p>${esc(err.message)}</p>
       <p class="loading-sub">Some sites block automated requests, or the URL may be unreachable.</p>`
    );
  }
}

function scoreColor(s) {
  if (s >= 70) return "var(--good)";
  if (s >= 40) return "var(--mid)";
  return "var(--bad)";
}

function render(res) {
  results.innerHTML = "";
  const card = el("section", "card site-report");
  const color = scoreColor(res.privacyScore);
  const modeLabel = res.mode === "deep" ? "Deep scan" : "Static scan";

  const trackerCount = res.knownTrackers.length;
  const adTrackers = res.knownTrackers.filter((t) => t.category === "advertising").length;

  card.append(
    el(
      "div",
      "report-head",
      `<div>
         <h2 class="site-name">${esc(res.domain)}</h2>
         <p class="site-meta">${modeLabel} · ${res.requestCount ?? res.resourceCount} requests · ${res.tookMs ?? "?"} ms</p>
       </div>
       <div class="score-ring" style="border-color:${color}" title="Privacy score (higher is better)">
         <span class="score-value">${res.privacyScore}</span>
         <span class="score-label">/100</span>
       </div>`
    )
  );

  if (res.degraded) {
    card.append(el("p", "notice", esc(res.degraded)));
  }

  card.append(
    el(
      "p",
      "site-summary",
      `Found <strong>${trackerCount}</strong> known tracker${trackerCount === 1 ? "" : "s"}` +
        (adTrackers ? ` (<strong>${adTrackers}</strong> advertising)` : "") +
        `, <strong>${res.otherThirdParty.length}</strong> third-party host${res.otherThirdParty.length === 1 ? "" : "s"} contacted, ` +
        `<strong>${res.cookies.length}</strong> cookie${res.cookies.length === 1 ? "" : "s"}` +
        ((res.fingerprinting && res.fingerprinting.length)
          ? `, and <strong>${res.fingerprinting.length}</strong> device-fingerprinting probe${res.fingerprinting.length === 1 ? "" : "s"}`
          : "") +
        `.`
    )
  );

  // Highlight: what the site actively learned about you in real time (deep scan only)
  if (res.fingerprinting && res.fingerprinting.length) {
    card.append(
      groupCard(
        "Fingerprinting the site ran on you",
        "Browser APIs the page actively called to identify your device",
        res.fingerprinting.map((f) => `<li><strong>${esc(f)}</strong></li>`),
        "highlight full"
      )
    );
  }

  // What the site can read about your environment for free
  if (res.environment && Object.keys(res.environment).length) {
    const envRows = Object.entries(res.environment)
      .filter(([, v]) => v)
      .map(([k, v]) => `<li><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></li>`);
    card.append(groupCard("What it can read about you", "Values exposed to any script on the page", envRows, "env full"));
  }

  const grid = el("div", "category-grid");

  grid.append(
    groupCard(
      "Trackers profiling you",
      "Third-party trackers identified by the database",
      res.knownTrackers.map((t) => {
        const label = CAT_LABELS[t.category] || t.category;
        return `<li><span><strong>${esc(t.owner)}</strong> — ${esc(label)}<br>
                <span class="dim">${esc(t.collects)}</span></span></li>`;
      })
    )
  );

  grid.append(
    groupCard(
      "Collected from you",
      "Data the page's forms ask you to enter",
      (res.dataFromYou || []).map(
        (d) => `<li><strong>${esc(d.label)}</strong> <span class="dim">(${esc(d.hint)})</span></li>`
      )
    )
  );

  grid.append(
    groupCard(
      "Cookies set",
      "Stored on your browser after loading the page",
      (res.cookies || []).slice(0, 40).map(
        (c) =>
          `<li>${esc(c.name)} <span class="dim">${c.thirdParty ? "third-party · " : ""}${c.persistent ? "persistent" : "session"}</span></li>`
      )
    )
  );

  if (res.storageKeys && res.storageKeys.length) {
    grid.append(
      groupCard(
        "Browser storage keys",
        "Data kept in localStorage / sessionStorage",
        res.storageKeys.slice(0, 40).map((k) => `<li>${esc(k)}</li>`)
      )
    );
  }

  grid.append(
    groupCard(
      "Other third-party hosts",
      "External domains contacted (not in the tracker database)",
      (res.otherThirdParty || []).slice(0, 40).map((h) => `<li>${esc(h)}</li>`)
    )
  );

  card.append(grid);
  card.append(
    el("p", "policy-link", `Scanned ${new Date(res.scannedAt).toLocaleString()} · status ${res.status || "?"}`)
  );

  results.append(card);
}

function groupCard(title, desc, items, extra = "") {
  const wrap = el("div", `category ${extra}` + (items.length ? "" : " empty"));
  wrap.append(el("h3", null, `${esc(title)}<span class="count">${items.length}</span>`));
  wrap.append(el("p", "cat-desc", esc(desc)));
  if (items.length) {
    wrap.append(el("ul", null, items.join("")));
  } else {
    wrap.append(el("p", "none", "None detected"));
  }
  return wrap;
}
