// FlipScan — on-demand "find it in shops, with prices" via SerpApi Google Lens.
// Google Lens needs a PUBLIC image URL (it can't take a raw upload), so we:
//   1. stash the photo in Upstash under a random id (~10-min TTL),
//   2. hand SerpApi the /api/img?id=... URL for THIS deployment,
//   3. return the visual matches (shop name + price + link).
// On-demand (a button), not per-scan, because SerpApi's free tier is ~100/month.

const MAX_IMG_CHARS = 3_600_000;

async function readJson(req) {
  if (req.body) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function redis(cmd) {
  const r = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error(`redis ${r.status}: ${await r.text()}`);
  return (await r.json()).result;
}
function parseDataUrl(d) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(d || "");
  if (!m) return null;
  return { m: m[1], b: m[2].replace(/\s+/g, "") };
}
async function fetchT(url, opts, ms) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); } finally { clearTimeout(t); }
}
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
    if (!process.env.FLIPSCAN_SECRET) return res.status(500).json({ error: "server_misconfigured" });
    if ((req.headers["x-flipscan-secret"] || "") !== process.env.FLIPSCAN_SECRET) return res.status(401).json({ error: "unauthorized" });
    if (!process.env.SERPAPI_KEY) return res.status(500).json({ error: "lens_not_configured" });
    if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return res.status(500).json({ error: "lens_not_configured" });

    const body = await readJson(req);
    if (typeof body.image !== "string" || body.image.length > MAX_IMG_CHARS) return res.status(400).json({ error: "bad_image" });
    const img = parseDataUrl(body.image);
    if (!img) return res.status(400).json({ error: "bad_image_format" });

    // 1) stash the image for SerpApi to fetch
    const id = newId();
    try { await redis(["SET", "flipscan:img:" + id, JSON.stringify(img), "EX", "600"]); }
    catch (e) { console.error("lens stash", e.message); return res.status(502).json({ error: "lens_failed" }); }

    // 2) build the public URL for THIS deployment
    const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    if (!host) return res.status(500).json({ error: "lens_failed" });
    const imgUrl = `${proto}://${host}/api/img?id=${id}`;

    // 3) call SerpApi Google Lens
    const country = process.env.SERPAPI_COUNTRY || "ie";
    const url = `https://serpapi.com/search.json?engine=google_lens&type=visual_matches&country=${encodeURIComponent(country)}&url=${encodeURIComponent(imgUrl)}&api_key=${process.env.SERPAPI_KEY}`;
    // Decision #4: one retry on timeout, then the user-friendly error.
    let r;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try { r = await fetchT(url, {}, 20000); break; }
      catch (e) {
        console.error("lens timeout attempt", attempt, e.message);
        if (attempt === 2) return res.status(504).json({ error: "lens_timeout" });
      }
    }
    if (r.status === 429) return res.status(429).json({ error: "lens_quota" });
    if (!r.ok) { console.error("lens http", r.status, await r.text().catch(() => "")); return res.status(502).json({ error: "lens_failed" }); }

    const data = await r.json();
    if (data.error) { console.error("lens api", data.error); return res.status(502).json({ error: "lens_failed" }); }

    const matches = (data.visual_matches || []).slice(0, 15).map((m) => ({
      title: m.title || "",
      source: m.source || "",
      url: m.link || "",
      image: m.thumbnail || null,
      price: (m.price && (m.price.value || m.price.extracted_value)) ? String(m.price.value || m.price.extracted_value) : null,
    })).filter((m) => m.url);

    // surface priced results first — those are the useful ones
    matches.sort((a, b) => (b.price ? 1 : 0) - (a.price ? 1 : 0));

    return res.status(200).json({ count: matches.length, matches });
  } catch (e) {
    console.error("lens handler", e);
    return res.status(500).json({ error: "server_error" });
  }
}
