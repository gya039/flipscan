// FlipScan — on-demand SOLD-price lookup via SoldComps (api.sold-comps.com).
// Called by a button per result, NOT on every scan, because the free plan is only
// 100 requests/month. One tap = one request. Returns real eBay *sold* comps.

export const maxDuration = 45; // Decision #2: up to 3 SoldComps calls (12s each) when broadening on thin

const SITE = process.env.SOLDCOMPS_SITE || "ebay.co.uk"; // Ireland has no eBay site; .co.uk is the closest
const SITE_CCY = { "ebay.co.uk": "GBP", "ebay.com": "USD", "ebay.de": "EUR", "ebay.fr": "EUR", "ebay.it": "EUR", "ebay.es": "EUR", "ebay.ca": "CAD", "ebay.com.au": "AUD" };
const MIN = 5; // sold data is scarcer than asking; trust it at 5+

async function readJson(req) {
  if (req.body) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}
async function fetchT(url, opts, ms) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); } finally { clearTimeout(t); }
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
    if (!process.env.FLIPSCAN_SECRET) return res.status(500).json({ error: "server_misconfigured" });
    if ((req.headers["x-flipscan-secret"] || "") !== process.env.FLIPSCAN_SECRET) return res.status(401).json({ error: "unauthorized" });
    if (!process.env.SOLDCOMPS_API_KEY) return res.status(500).json({ error: "server_misconfigured" });

    const body = await readJson(req);
    const trim = (s) => String(s || "").replace(/\bunknown\b/gi, " ").replace(/\s+/g, " ").trim().slice(0, 200).split(/\s+/).slice(0, 5).join(" ");
    // Decision #2: query levels to broaden on thin — full -> no-material -> no-colour.
    // Mirrors comps.js/vinted.js. One SoldComps call per level; stop at the first with >= MIN sales.
    const levels = Array.isArray(body.queries) && body.queries.length
      ? body.queries.map((x) => ({ level: x.level || "full", q: trim(x.q) })).filter((x) => x.q)
      : (trim(body.query) ? [{ level: "full", q: trim(body.query) }] : []);
    if (!levels.length) return res.status(400).json({ error: "no_query" });
    const branded = !!body.branded;

    const ccy = SITE_CCY[SITE] || "GBP";
    // NOTE: no buyingFormat filter -> include auctions AND accepted-offer sales (they're
    // all real sold prices). Filtering to Buy-It-Now only drops most used-clothing sales.
    async function soldSearch(query) {
      const url = `https://api.sold-comps.com/v1/scrape?sold=true&itemCondition=used&count=240&ebaySite=${encodeURIComponent(SITE)}&keyword=${encodeURIComponent(query)}`;
      const r = await fetchT(url, { headers: { Authorization: `Bearer ${process.env.SOLDCOMPS_API_KEY}` } }, 12000);
      if (r.status === 429) { const e = new Error("quota"); e.code = 429; throw e; }
      if (r.status === 401) { const e = new Error("auth"); e.code = 401; throw e; }
      if (!r.ok) { console.error("sold http", r.status, await r.text()); const e = new Error("http"); e.code = 502; throw e; }
      const data = await r.json();
      const items = (data.items || []).filter((i) => i.soldPrice != null && (!i.soldCurrency || i.soldCurrency === ccy));
      const prices = items.map((i) => parseFloat(i.soldPrice)).filter((n) => !isNaN(n)).sort((a, b) => a - b);
      return { items, prices };
    }

    let best = null, bestLevel = null;
    try {
      for (const { level, q } of levels) {
        const got = await soldSearch(q);
        if (!best || got.prices.length > best.prices.length) { best = got; bestLevel = level; }
        if (got.prices.length >= MIN) { best = got; bestLevel = level; break; }
      }
    } catch (e) {
      if (e.code === 429) return res.status(429).json({ error: "sold_quota" });
      if (e.code === 401) { console.error("sold auth"); return res.status(502).json({ error: "sold_auth" }); }
      if (e.name === "AbortError") { console.error("sold timeout", e.message); return res.status(504).json({ error: "sold_timeout" }); }
      console.error("sold search", e.message); return res.status(502).json({ error: "sold_failed" });
    }

    const { items, prices } = best || { items: [], prices: [] };
    if (!prices.length) return res.status(200).json({ basis: "sold", source: "eBay sold", site: SITE, currency: ccy, count: 0, queryLevel: bestLevel, reliable: false, low: null, median: null, anchor: null, high: null, examples: [] });

    const examples = [...items].sort((a, b) => String(b.endedAt || "").localeCompare(String(a.endedAt || ""))).slice(0, 4)
      .map((i) => ({ title: i.title, price: `${i.soldPrice} ${i.soldCurrency || ccy}`, url: i.url, image: i.thumbnailUrl || null, endedAt: i.endedAt || "" }));

    const median = pct(prices, 50);
    // Part A: a GENERIC item priced off a BROADENED query is a loose match — anchor on p40, not the median.
    const broadened = !!bestLevel && bestLevel !== "full";
    const anchor = (!branded && broadened) ? pct(prices, 40) : median;
    return res.status(200).json({
      basis: "sold", source: "eBay sold", site: SITE, currency: ccy,
      count: prices.length, capped: prices.length >= 240, queryLevel: bestLevel, reliable: prices.length >= MIN,
      low: pct(prices, 10), median, anchor, high: pct(prices, 90), examples,
    });
  } catch (e) {
    console.error("sold handler", e); return res.status(500).json({ error: "server_error" });
  }
}
