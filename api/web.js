// FlipScan — on-demand reverse image search via Google Cloud Vision (web detection).
// A button, NOT part of every scan — so you only spend a call when you actually want
// to hunt the exact item across the web (brand site, boutiques, other marketplaces).
// Takes the photo directly (base64), no hosting needed. Free up to ~1,000/month.

const MAX_IMG_CHARS = 3_600_000;

async function readJson(req) {
  if (req.body) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function parseDataUrl(d) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(d || "");
  if (!m) return null;
  return { mediaType: m[1], b64: m[2].replace(/\s+/g, "") };
}
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } }
async function fetchT(url, opts, ms) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); } finally { clearTimeout(t); }
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
    if (!process.env.FLIPSCAN_SECRET) return res.status(500).json({ error: "server_misconfigured" });
    if ((req.headers["x-flipscan-secret"] || "") !== process.env.FLIPSCAN_SECRET) return res.status(401).json({ error: "unauthorized" });
    if (!process.env.GOOGLE_VISION_API_KEY) return res.status(500).json({ error: "web_not_configured" });

    const body = await readJson(req);
    if (typeof body.image !== "string" || body.image.length > MAX_IMG_CHARS) return res.status(400).json({ error: "bad_image" });
    const img = parseDataUrl(body.image);
    if (!img) return res.status(400).json({ error: "bad_image_format" });

    let r;
    try {
      r = await fetchT(`https://vision.googleapis.com/v1/images:annotate?key=${process.env.GOOGLE_VISION_API_KEY}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ requests: [{ image: { content: img.b64 }, features: [{ type: "WEB_DETECTION", maxResults: 12 }] }] }),
      }, 10000);
    } catch (e) { console.error("vision timeout:", e.message); return res.status(504).json({ error: "web_timeout" }); }
    if (!r.ok) { console.error("vision:", r.status, await r.text().catch(() => "")); return res.status(502).json({ error: "web_failed" }); }

    const w = (((await r.json()).responses || [])[0] || {}).webDetection || {};
    const bestRaw = (w.bestGuessLabels || [])[0]?.label || null;
    // Only surface a best-guess when it's specific (≥2 words) — a bare "vest" is noise.
    const best = bestRaw && bestRaw.trim().split(/\s+/).length >= 2 ? bestRaw : null;
    const entities = (w.webEntities || []).filter((e) => e.description && e.score > 0.2).slice(0, 5).map((e) => e.description);

    const raw = (w.pagesWithMatchingImages || [])
      .map((p) => ({ title: p.pageTitle || hostOf(p.url), url: p.url, site: hostOf(p.url), full: (p.fullMatchingImages || []).length > 0 }))
      .filter((p) => p.url && p.site);
    raw.sort((a, b) => (b.full ? 1 : 0) - (a.full ? 1 : 0)); // exact-image matches first
    const seen = new Set(), pages = [];
    for (const p of raw) { if (seen.has(p.site)) continue; seen.add(p.site); pages.push(p); if (pages.length >= 8) break; } // one per site = variety

    return res.status(200).json({ best_guess: best, entities, pages });
  } catch (e) {
    console.error("web handler", e);
    return res.status(500).json({ error: "server_error" });
  }
}
