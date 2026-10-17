// FlipScan — comps-only re-run (NO vision), used when the user edits the brand/item_type
// chips on the result screen (fix #4). Keyword eBay search + the same anchoring/cleaning as
// scan.js. Mirrors scan.js's keyword path; keep the two in sync.

const MIN_COMPS = 8;
const CLOTHING_CAT = "11450";
const MARKET_CCY = { EBAY_GB: "GBP", EBAY_IE: "EUR", EBAY_DE: "EUR", EBAY_FR: "EUR", EBAY_ES: "EUR", EBAY_IT: "EUR", EBAY_US: "USD" };
const EBAY_FILTER = encodeURIComponent("buyingOptions:{FIXED_PRICE},conditionIds:{3000}");

async function readJson(req) {
  if (req.body) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function fetchT(url, opts, ms) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); } finally { clearTimeout(t); }
}
function pct(s, p) { if (!s.length) return null; const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1)))); return s[i]; }
function cleanPrices(prices) {
  if (prices.length < 4) return prices;
  const m = pct(prices, 50); if (!m) return prices;
  const kept = prices.filter((p) => p >= m * 0.4 && p <= m * 2.5);
  return kept.length >= Math.max(3, Math.ceil(prices.length * 0.5)) ? kept : prices;
}
function gradeComps(count, low, median, high) {
  const tight = (low != null && median != null && high != null && median > 0) ? (high - low) <= median * 1.5 : false;
  let confidence = "low";
  if (count >= MIN_COMPS) confidence = tight ? "high" : "medium"; else if (count >= 3) confidence = "medium";
  return { tight, confidence };
}
function okItems(data, ccy) { return (data.itemSummaries || []).filter((i) => i.price && i.price.currency === ccy && !isNaN(parseFloat(i.price.value))); }

let ebayToken = { value: null, exp: 0 };
async function ebayAuth() {
  if (ebayToken.value && Date.now() < ebayToken.exp) return ebayToken.value;
  const basic = Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString("base64");
  const r = await fetchT("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST", headers: { Authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  }, 5000);
  if (!r.ok) throw new Error(`ebay auth ${r.status}`);
  const d = await r.json(); ebayToken = { value: d.access_token, exp: Date.now() + (d.expires_in - 60) * 1000 };
  return ebayToken.value;
}
async function ebaySearch(query, token, market, ccy) {
  const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?limit=50&category_ids=${CLOTHING_CAT}&filter=${EBAY_FILTER}&q=${encodeURIComponent(query)}`;
  const r = await fetchT(url, { headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": market } }, 6000);
  if (!r.ok) throw new Error(`ebay browse ${r.status}`);
  return okItems(await r.json(), ccy);
}
function summarise(items, ccy, market, used, branded, level) {
  if (!items.length) return { source: "eBay active listings (asking)", visual: false, marketplace: market, query: used, count: 0, currency: ccy, reliable: false, confidence: "low", tight: false, low: null, anchor: null, median: null, high: null, examples: [] };
  let prices = items.map((i) => parseFloat(i.price.value)).sort((a, b) => a - b);
  const rawCount = prices.length;
  if (!branded) prices = cleanPrices(prices);
  const low = pct(prices, 10), median = pct(prices, 50), high = pct(prices, 90);
  // Part A: generic + broadened query = loose match, anchor on p40 instead of the median.
  const broadened = !!level && level !== "full" && level !== "image";
  const anchor = branded ? pct(prices, 30) : (broadened ? pct(prices, 40) : median);
  const picked = [...items].sort((a, b) => Math.abs(parseFloat(a.price.value) - anchor) - Math.abs(parseFloat(b.price.value) - anchor)).slice(0, 6);
  const examples = picked.map((i) => ({ title: i.title, price: `${i.price.value} ${i.price.currency}`, url: i.itemWebUrl, image: (i.image && i.image.imageUrl) || null, condition: i.condition || "" }));
  const { tight, confidence } = gradeComps(prices.length, low, median, high);
  return { source: "eBay active listings (asking)", visual: false, marketplace: market, query: used, branded: !!branded, count: prices.length, rawCount, dropped: rawCount - prices.length, currency: ccy, reliable: prices.length >= MIN_COMPS, confidence, tight, low, anchor, median, high, examples };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
    if (!process.env.FLIPSCAN_SECRET) return res.status(500).json({ error: "server_misconfigured" });
    if ((req.headers["x-flipscan-secret"] || "") !== process.env.FLIPSCAN_SECRET) return res.status(401).json({ error: "unauthorized" });
    if (!process.env.EBAY_CLIENT_ID || !process.env.EBAY_CLIENT_SECRET) return res.status(500).json({ error: "comps_not_configured" });

    const body = await readJson(req);
    const levels = Array.isArray(body.queries) && body.queries.length
      ? body.queries.map((x) => ({ level: x.level || "full", q: String(x.q || "").replace(/\s+/g, " ").trim().slice(0, 80) })).filter((x) => x.q)
      : (String(body.query || "").trim() ? [{ level: "full", q: String(body.query).replace(/\s+/g, " ").trim().slice(0, 80) }] : []);
    if (!levels.length) return res.status(400).json({ error: "no_query" });
    const branded = !!body.branded;
    const market = process.env.EBAY_MARKETPLACE || "EBAY_GB";
    const ccy = MARKET_CCY[market] || "GBP";

    let token; try { token = await ebayAuth(); } catch (e) { console.error("comps auth", e.message); return res.status(502).json({ error: "comps_failed" }); }
    // broaden on thin: full -> no-material -> no-colour (Decision #2)
    let best = null, bestLevel = null, bestQ = "";
    for (const { level, q } of levels) {
      let items; try { items = await ebaySearch(q, token, market, ccy); } catch (e) { console.error("comps kw", level, e.message); continue; }
      if (!best || items.length > best.length) { best = items; bestLevel = level; bestQ = q; }
      if (items.length >= MIN_COMPS) { best = items; bestLevel = level; bestQ = q; break; }
    }
    if (!best) return res.status(502).json({ error: "comps_failed" });
    const s = summarise(best, ccy, market, bestQ, branded, bestLevel); s.queryLevel = bestLevel;
    return res.status(200).json(s);
  } catch (e) {
    console.error("comps handler", e);
    return res.status(500).json({ error: "server_error" });
  }
}
