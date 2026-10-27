// FlipScan — on-demand Vinted ASKING-price comps via Apify.
// Actor: epicscrapers/vinted-search-scraper (run-sync-get-dataset-items).
// A BUTTON, not per-scan: Apify runs are slow (~10-25s) and paid (~€0.0015/listing),
// so we only spend when asked, and cache each query 24h (Upstash) to cut cost.
// Vinted has NO sold data — these are active-listing asking prices, like eBay Browse,
// so we 30th-percentile anchor the same way. Searches vinted.ie first; if fewer than
// 8 results, falls back to vinted.fr (both EUR, Vinted is pan-EU so prices compare).

import { classify } from "../lib/relevance.js";
import { judgeFilter } from "../lib/judge.js";

export const maxDuration = 60; // Apify run-sync can take 20s+; raise Vercel's function ceiling

const ACTOR = "epicscrapers~vinted-search-scraper";
const WANT = 8;           // enough IE results to not bother falling back to FR
const CACHE_TTL = 86400;  // 24h
const APIFY_MS = 24000;   // per-country Apify timeout

// #2: Vinted's brand / catalog filters live in the search URL (the actor has no input
// field for them). Supply the numeric ids via env as JSON — read them straight off a
// filtered Vinted URL (apply the filter on Vinted, copy ?catalog[]=.. / &brand_ids[]=..).
// Keyed by our relevance category id (see lib/relevance.js) and by lowercased brand.
//   VINTED_CATALOG_IDS = {"football_shirt":"2050","jeans":"257", ...}
//   VINTED_BRAND_IDS   = {"nike":"53","adidas":"14", ...}
function parseEnvMap(name) {
  try { const v = process.env[name]; return v ? JSON.parse(v) : {}; } catch { return {}; }
}
const CATALOG_IDS = parseEnvMap("VINTED_CATALOG_IDS");
const BRAND_IDS = parseEnvMap("VINTED_BRAND_IDS");
function domainFor(cc) { return cc === "fr" ? "www.vinted.fr" : "www.vinted.ie"; }
// Build a Vinted catalog URL with search_text + ordered results, plus catalog[] / brand_ids[]
// whenever we have an id for this garment category / brand. Returns null if nothing to target.
function catalogUrl(query, cc, cat, brand) {
  const catId = cat && CATALOG_IDS[cat];
  const brandId = brand && BRAND_IDS[String(brand).toLowerCase()];
  if (!catId && !brandId) return null; // no verified ids -> fall back to keyword search
  const p = new URLSearchParams();
  p.set("search_text", query);
  p.set("order", "newest_first");
  let u = `https://${domainFor(cc)}/catalog?${p.toString()}`;
  if (catId) u += `&catalog[]=${encodeURIComponent(catId)}`;
  if (brandId) u += `&brand_ids[]=${encodeURIComponent(brandId)}`;
  return u;
}

async function readJson(req) {
  if (req.body) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function fetchT(url, opts, ms) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); } finally { clearTimeout(t); }
}
async function redis(cmd) {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  const r = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error(`redis ${r.status}`);
  return (await r.json()).result;
}
function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}
// fix #2: for a generic (unknown-brand) search, drop outliers (<0.4x or >2.5x the raw median)
// before anchoring so cheap fast-fashion listings don't drag the price down.
function cleanPrices(prices) {
  if (prices.length < 4) return prices;
  const m = pct(prices, 50);
  if (!m) return prices;
  const kept = prices.filter((p) => p >= m * 0.4 && p <= m * 2.5);
  return kept.length >= Math.max(3, Math.ceil(prices.length * 0.5)) ? kept : prices;
}
function gradeComps(count, low, median, high) {
  const tight = (low != null && median != null && high != null && median > 0) ? (high - low) <= median * 1.5 : false;
  let confidence = "low";
  if (count >= 8) confidence = tight ? "high" : "medium";
  else if (count >= 3) confidence = "medium";
  return { tight, confidence };
}
function imgOf(it) {
  const p = it.photo || (Array.isArray(it.photos) && it.photos[0]) || null;
  if (!p) return null;
  return p.url || p.full_size_url || (p.thumbnails && p.thumbnails[0] && p.thumbnails[0].url) || null;
}

// Run the actor for one Vinted country site, return EUR asking prices + raw rows.
// idMeta ({brand,itemType}) drives the relevance filter (#1) so a "Nike shirt" search
// isn't priced off Vinted dresses that merely matched the keywords.
async function scrapeCountry(query, country, idMeta) {
  const url = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?format=json`;
  // #2: prefer a catalog/brand-filtered Vinted URL when we have the ids; else keyword search.
  const catUrl = catalogUrl(query, country, idMeta && idMeta.cat, idMeta && idMeta.brand);
  const input = catUrl
    ? { startUrls: [{ url: catUrl }], maxProducts: 20 }
    : { keywords: [query], country, maxProducts: 20 };
  const r = await fetchT(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.APIFY_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  }, APIFY_MS);
  if (!r.ok) throw new Error(`apify ${r.status}`);
  const items = await r.json();
  return (Array.isArray(items) ? items : []).filter(   // raw EUR rows; relevance is judged once, below
    (it) => it && it.price && (it.price.currency_code === "EUR" || !it.price.currency_code) && !isNaN(parseFloat(it.price.amount))
  );
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
    if (!process.env.FLIPSCAN_SECRET) return res.status(500).json({ error: "server_misconfigured" });
    if ((req.headers["x-flipscan-secret"] || "") !== process.env.FLIPSCAN_SECRET) return res.status(401).json({ error: "unauthorized" });
    if (!process.env.APIFY_TOKEN) return res.status(500).json({ error: "vinted_not_configured" });

    const body = await readJson(req);
    const raw = String(body.query || "").replace(/\bunknown\b/gi, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!raw) return res.status(400).json({ error: "no_query" });
    const query = raw.split(/\s+/).slice(0, 5).join(" "); // shorter query = more comps
    const branded = !!body.branded;
    const idMeta = { brand: body.brand || "", itemType: body.itemType || body.item_type || "" };
    idMeta.cat = (classify(idMeta.itemType) || {}).id || null; // for the catalog[] filter (#2)

    // 24h cache (per query + branded flag) to keep Apify spend down.
    const cacheKey = "flipscan:vinted:v4:" + (branded ? "b:" : "") + query.toLowerCase();
    try { const cached = await redis(["GET", cacheKey]); if (cached) return res.status(200).json(JSON.parse(cached)); }
    catch (e) { console.error("vinted cache read", e.message); }

    // Decision #2: query levels to broaden on thin — full -> no-material -> no-colour.
    const levels = Array.isArray(body.queries) && body.queries.length
      ? body.queries.map((x) => ({ level: x.level || "full", q: String(x.q || "").split(/\s+/).slice(0, 5).join(" ").trim() })).filter((x) => x.q)
      : [{ level: "full", q: query }];

    // Try each level on IE (keep the best); fall back to FR with the full query only if still thin.
    let country = "ie", rows = [], usedLevel = levels[0].level, usedQ = levels[0].q;
    for (const { level, q } of levels) {
      try { const r = await scrapeCountry(q, "ie", idMeta); if (r.length > rows.length) { rows = r; usedLevel = level; usedQ = q; } }
      catch (e) { console.error("vinted ie", level, e.message); }
      if (rows.length >= WANT) break;
    }
    if (rows.length < WANT) {
      try { const fr = await scrapeCountry(levels[0].q, "fr", idMeta); if (fr.length > rows.length) { rows = fr; country = "fr"; usedLevel = levels[0].level; usedQ = levels[0].q; } }
      catch (e) { console.error("vinted fr", e.message); }
    }
    // Relevance: one judge pass over the chosen rows (universal code filters, then Haiku).
    const identity = { brand: body.brand || "", item_type: body.itemType || body.item_type || "", colour: body.colour || "", material: body.material || "", club: body.club || "", key_features: body.key_features || "" };
    const jf = await judgeFilter(identity, rows, (it) => it.title || it.brand_title || "", (it) => parseFloat(it.price.amount), "vinted");
    rows = jf.kept;
    const keptOf = jf.total, drops = jf.drops, judge = jf.judge;

    if (!rows.length) {
      const empty = { source: "Vinted", country, query: usedQ, count: 0, keptOf, drops, judge, currency: "EUR", reliable: false, confidence: "low", tight: false, low: null, anchor: null, median: null, high: null, examples: [] };
      return res.status(200).json(empty);
    }

    let prices = rows.map((it) => parseFloat(it.price.amount)).sort((a, b) => a - b);
    const rawCount = prices.length;
    if (!branded) prices = cleanPrices(prices);
    const low = pct(prices, 10), median = pct(prices, 50), high = pct(prices, 90);
    // branded: lower-third (p30); generic: cleaned median — but a generic item on a BROADENED query is a loose match, so anchor on p40.
    const broadened = usedLevel !== "full" && usedLevel !== "image";
    const anchor = branded ? pct(prices, 30) : (broadened ? pct(prices, 40) : median);
    const { tight, confidence } = gradeComps(prices.length, low, median, high);
    // Examples: the 6 priced closest to the anchor (no visual signal from Vinted).
    const examples = [...rows]
      .sort((a, b) => Math.abs(parseFloat(a.price.amount) - anchor) - Math.abs(parseFloat(b.price.amount) - anchor))
      .slice(0, 6)
      .map((it) => ({ title: it.title || it.brand_title || "Vinted listing", price: `€${Math.round(parseFloat(it.price.amount))}`, url: it.url, image: imgOf(it), condition: it.status || "" }));

    const result = {
      source: "Vinted", country, query: usedQ, branded, queryLevel: usedLevel, count: prices.length, rawCount, keptOf, drops, judge, dropped: rawCount - prices.length, currency: "EUR",
      reliable: prices.length >= WANT, confidence, tight,
      low, anchor, median, high, examples,
    };

    try { await redis(["SET", cacheKey, JSON.stringify(result), "EX", String(CACHE_TTL)]); }
    catch (e) { console.error("vinted cache write", e.message); }

    return res.status(200).json(result);
  } catch (e) {
    console.error("vinted handler", e);
    return res.status(500).json({ error: "server_error" });
  }
}
