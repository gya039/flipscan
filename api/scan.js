// FlipScan — serverless function (Vercel, Node 18+ runtime, ESM, zero deps).
// Flow: photo(s) -> Claude Haiku (forced tool-call -> structured identity)
//       -> (optional) filtered eBay comps -> one JSON response { identity, comps }.
// A comps failure never fails the whole scan. Secrets stay server-side.

import { filterComps, classify } from "../lib/relevance.js";

const MODEL = "claude-haiku-4-5-20251001";
// fix #5: re-run a LOW-confidence identification once on a stronger model. Override the id via
// the ESCALATION_MODEL env var to match your account; set it to "" to disable escalation.
const ESCALATION_MODEL = process.env.ESCALATION_MODEL !== undefined ? process.env.ESCALATION_MODEL : "claude-sonnet-4-5";

const MAX_IMAGES = 5;
const MAX_IMG_CHARS = 3_600_000;   // ~2.6MB per image (data-URL string length)
const MAX_TOTAL_CHARS = 9_000_000; // ~6.5MB total
const MIN_COMPS = 8;               // below this, comps are flagged unreliable
const IMG_MIN = 3;                  // enough visual matches to prefer image search over keyword
const CLOTHING_CAT = "11450";      // eBay "Clothing, Shoes & Accessories" (verify per marketplace)
const MARKET_CCY = { EBAY_GB: "GBP", EBAY_IE: "EUR", EBAY_DE: "EUR", EBAY_FR: "EUR", EBAY_ES: "EUR", EBAY_IT: "EUR", EBAY_US: "USD" };

// ---- helpers -------------------------------------------------------------
async function readJson(req) {
  if (req.body) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}
function parseDataUrl(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl || "");
  if (!m) return null;                      // reject anything that isn't a clean image data URL
  return { mediaType: m[1], b64: m[2].replace(/\s+/g, "") };
}
function cleanQuery(s) {
  return String(s || "").replace(/\bunknown\b/gi, " ").replace(/\s+/g, " ").trim();
}
async function fetchT(url, opts, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}
class StageError extends Error { constructor(stage, detail) { super(detail); this.stage = stage; } }

// ---- 1. identify the item with Claude (forced tool call = always valid JSON) ----
const RULES =
`Work carefully and AVOID these common mistakes that cost resellers money:
1. TYPE from silhouette: it's usually ONE garment, often folded, flat-laid or styled. Don't mistake folded sleeves for trouser legs, a flat-laid top for a skirt, a cropped hem hidden by a fold for a full-length top, or a two-piece set for a single item. Judge the type from the collar, neckline, cuffs, buttons, zips and hems — not the outline. An open front could be a cardigan, zip-hoodie or jacket — check before deciding.
2. BRAND vs PRINT: the real brand is on the NECK/CARE LABEL. A logo, band, cartoon, team or slogan printed on the fabric is the DESIGN, not the maker (e.g. a Primark tee with a Nike graphic is NOT Nike). If you can't see a maker's label, set "brand" to "unknown" and put the graphic in "key_features".
3. VINTAGE vs MODERN REPRO: don't call it vintage unless label style, stitching, fabric-content wording or a "made in" cue supports it — lots of Y2K/90s-looking pieces are new fast fashion. If unsure, use "unknown" or "modern repro?" for era.
4. SIZE: only state a size you can actually READ on the label. Never infer it from the photo — with no scale it could even be kids' sizing; flag that if relevant.
5. CONDITION: creases, shadows and folds are NOT flaws. Only flag stains, holes, pilling or fading you can clearly see.
6. MATERIAL: don't assert silk, leather, wool or real fur from looks alone — satin polyester mimics silk, PU mimics leather, faux mimics fur. Say "looks like X" or defer to the label.
7. IGNORE the background, hanger, mannequin, hands and reflections — identify only the garment.
8. If the type or brand is genuinely ambiguous, describe what you can see and set "confidence" to "low" rather than guess.
9. COMMIT to ONE item_type. Never write "X or Y" (e.g. "gilet or sleeveless jacket") — pick the single most likely type. Hedging with "or" is treated as low confidence.
10. FOOTBALL/SPORTS SHIRTS: only call it a "football shirt" and fill "club"/"season" when you can actually SEE a club crest, badge or shirt sponsor. If there's no visible crest/sponsor, use item_type "football-style top" and leave club/season empty — a plain sporty top must NOT be priced against real club shirts.`;

const IDENTITY_TOOL = {
  name: "report_item",
  description: "Report the identification of the clothing item for resale pricing.",
  input_schema: {
    type: "object",
    properties: {
      brand: { type: "string", description: "Maker from the neck/care label, or 'unknown'. NOT a printed graphic." },
      item_type: { type: "string", description: "ONE garment type, e.g. 'long-sleeve floral top','track jacket'. Include sleeve length for tops when visible. Never hedge with 'X or Y'. For a sporty top with NO visible club crest/sponsor use 'football-style top' (not 'football shirt')." },
      era: { type: "string", description: "'1990s','Y2K','2000s','unknown', or 'modern repro?'." },
      key_features: { type: "string", description: "Pattern, notable details, any printed graphic (colour goes in 'colour')." },
      colour: { type: "string", description: "Main colour(s), lowercase, 1-3 words, e.g. 'black','mustard yellow','navy'. '' if unclear." },
      material: { type: "string", description: "Main material if clear, lowercase, one word, e.g. 'leather','denim','wool','nylon','cotton'. '' if unsure." },
      size: { type: "string", description: "Only if readable on the label, else 'unknown'." },
      club: { type: "string", description: "FOOTBALL/SPORTS SHIRTS ONLY: the team/club from the crest, sponsor or badge (e.g. 'Celtic', 'Brazil'), or '' if you can't read the crest. Don't guess." },
      season: { type: "string", description: "FOOTBALL/SPORTS SHIRTS ONLY: the season if datable from sponsor/kit maker/design, e.g. '2004-05', else ''." },
      home_away: { type: "string", description: "FOOTBALL/SPORTS SHIRTS ONLY: 'home', 'away', 'third', 'goalkeeper' or '' if unclear." },
      player: { type: "string", description: "FOOTBALL/SPORTS SHIRTS ONLY: player name/number printed on the back, else ''." },
      condition_notes: { type: "string", description: "Visible flaws only (stains/holes/pilling/fading)." },
      condition: { type: "string", enum: ["like new", "good", "fair", "poor"], description: "Overall wear grade from the photos. 'like new' = no visible wear. 'good' = minimal wear, no flaws. 'fair' = LIGHT wear only (slight creasing, minor bobbling). 'poor' = ANY heavy fading, pilling, stains, holes or visible damage — if you can see fading/pilling/stains/holes/damage, grade it 'poor', not 'fair'." },
      condition_reason: { type: "string", description: "One short plain line explaining the condition grade from what's visible, e.g. 'heavy fading across the front' or 'clean, only light creasing'. Everyday words." },
      notes: { type: "string", description: "One short, plain line like a mate would say — what makes it worth money, or what to double-check. Everyday words only; NO marketing speak (avoid 'appeals to buyers', 'nostalgia', 'sought-after', 'coveted')." },
      authenticity_flags: { type: "string", description: "Short note if anything looks fake/bootleg, else 'none'." },
      price_tag_eur: { type: ["number", "null"], description: "ONLY if a shop/charity/thrift PRICE STICKER or hand-written price tag is clearly VISIBLE on the item in the photo, the number on it, in EUR (convert from £/$ at a rough rate if needed). This is what it costs to BUY, not a size or product code. If no price tag is clearly readable, use null. Never guess a price here." },
      confidence: { type: "string", enum: ["high", "medium", "low"], description: "Overall confidence in the identification." },
      estimated_resale_eur: {
        type: "object",
        description: "Best estimate of the realistic secondhand price range, in EUR, on the stated platform for a buyer in Ireland, in the ACTUAL condition visible in the photos.",
        properties: { low: { type: "number" }, high: { type: "number" } },
        required: ["low", "high"],
      },
    },
    required: ["brand", "item_type", "era", "confidence", "estimated_resale_eur"],
  },
};

// fix #4: build the eBay/Vinted query deterministically from structured fields — brand (if
// known) + colour + material + item_type — so the same fields always give the same query,
// and editing a field re-derives it. No free-text from the model.
// Part A #2: drop duplicate words (case-insensitive, keep first) so fields that overlap don't
// produce "denim denim" or "leather sherpa-lined leather jacket". Also drop stop-words so a
// hedged item_type ("gilet or sleeveless jacket") can't leak "or"/"and" into the search.
const QUERY_STOP = new Set(["or", "and", "with", "the", "a", "an", "of"]);
function dedupeWords(s) {
  const seen = new Set(), out = [];
  for (const w of String(s).split(/\s+/)) { if (!w) continue; const k = w.toLowerCase(); if (QUERY_STOP.has(k) || seen.has(k)) continue; seen.add(k); out.push(w); }
  return out.join(" ");
}
const brandOf = (id) => (id.brand && String(id.brand).toLowerCase() !== "unknown") ? id.brand : "";
const isFootball = (id) => { const c = classify(id.item_type); return c && c.id === "football_shirt"; };
const jq = (arr) => dedupeWords(arr.map((x) => String(x || "").trim()).filter(Boolean).join(" ").replace(/\s+/g, " ")).slice(0, 80);

function buildQuery(id) {
  // #3: football/sports shirts search best on CLUB + SEASON + BRAND, not colour/material.
  if (isFootball(id) && (id.club || id.season)) return jq([id.club, id.season, id.home_away, brandOf(id), "football shirt"]);
  return jq([brandOf(id), id.colour, id.material, id.item_type]);
}
// Decision #2: ordered query levels to broaden a thin search — full → drop material → drop colour.
// #3: for football shirts, broaden club+season+brand → club+brand → brand instead.
function buildQueryLevels(id) {
  const brand = brandOf(id);
  if (isFootball(id) && (id.club || id.season)) {
    const out = [{ level: "full", q: jq([id.club, id.season, id.home_away, brand, "football shirt"]) }];
    const noSeason = jq([id.club, brand, "football shirt"]);
    const noClub = jq([brand, "football shirt"]);
    if (noSeason && noSeason !== out[0].q) out.push({ level: "no-season", q: noSeason });
    if (noClub && noClub !== noSeason && noClub !== out[0].q) out.push({ level: "no-club", q: noClub });
    return out;
  }
  const full = jq([brand, id.colour, id.material, id.item_type]);
  const noMat = jq([brand, id.colour, id.item_type]);
  const noCol = jq([brand, id.item_type]);
  const out = [{ level: "full", q: full }];
  if (noMat && noMat !== full) out.push({ level: "no-material", q: noMat });
  if (noCol && noCol !== noMat && noCol !== full) out.push({ level: "no-colour", q: noCol });
  return out;
}

function cleanEstimate(e) {
  if (!e) return null;
  let lo = Number(e.low), hi = Number(e.high);
  if (!isFinite(lo) || !isFinite(hi) || lo <= 0 || hi <= 0) return null;
  if (lo > hi) [lo, hi] = [hi, lo];
  return { low: Math.round(lo), high: Math.round(hi) };
}

async function callModel(model, imgBlocks, text) {
  let r;
  try {
    r = await fetchT("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model, max_tokens: 1000, temperature: 0,
        tools: [IDENTITY_TOOL], tool_choice: { type: "tool", name: "report_item" },
        messages: [{ role: "user", content: [...imgBlocks, { type: "text", text }] }],
      }),
    }, 25000);
  } catch (e) {
    throw new StageError("identify_timeout", String(e.message || e));
  }
  if (!r.ok) throw new StageError("identify_failed", `Anthropic ${r.status}: ${await r.text()}`);
  const data = await r.json();
  if (data.stop_reason === "max_tokens") throw new StageError("identify_truncated", "model reply hit max_tokens");
  const block = (data.content || []).find((b) => b.type === "tool_use");
  if (!block || !block.input) throw new StageError("identify_failed", "no tool_use block in reply");
  return block.input;
}
const hedged = (id) => / or /i.test(String(id.item_type || "")); // "X or Y" = a hedge between two types

function finaliseId(id, model) {
  id.estimated_resale_eur = cleanEstimate(id.estimated_resale_eur);
  const pt = Number(id.price_tag_eur);
  id.price_tag_eur = (isFinite(pt) && pt > 0 && pt < 100000) ? Math.round(pt * 100) / 100 : null; // sanitise
  for (const k of ["club", "season", "home_away", "player"]) id[k] = String(id[k] || "").trim();
  // #3: a football/sports top with NO visible crest/sponsor must NOT be priced against real
  // club shirts — call it a "football-style top" so comps don't pull in club kits.
  if (isFootball(id) && !id.club && !id.season) {
    id.item_type = "football-style top";
    id.notes = ("no crest/sponsor visible — treated as a football-style top, not a club shirt. " + (id.notes || "")).trim().slice(0, 200);
    if (String(id.confidence || "").toLowerCase() === "high") id.confidence = "medium";
  }
  id.search_query = buildQuery(id);   // fix #4: deterministic (built AFTER the type is normalised)
  const cond = String(id.condition || "").toLowerCase().trim();
  id.condition = ["like new", "good", "fair", "poor"].includes(cond) ? cond : "good"; // Part A #1: default used clothing to 'good'
  id.condition_reason = String(id.condition_reason || "").trim().slice(0, 120);
  id.model_used = model;
  return id;
}

async function identify(images, note) {
  const platform = process.env.SELL_PLATFORM || "Vinted";
  const imgBlocks = images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.mediaType, data: im.b64 } }));
  const text =
`You are an expert vintage-clothing identifier helping a reseller price an item. You may be given SEVERAL photos of the SAME item (different angles and its labels) — use them all together.

${RULES}

For "estimated_resale_eur", give the realistic secondhand price on ${platform} for a buyer in Ireland, in the condition actually visible in the photos.
Call the report_item tool with your assessment.`;

  const id = await callModel(MODEL, imgBlocks, text);
  // #4: an "X or Y" item_type is a hedge — treat as low confidence so escalation forces a commit.
  if (hedged(id)) id.confidence = "low";
  // fix #5: if the default model is UNSURE, re-run identification once on a stronger model.
  if (String(id.confidence || "").toLowerCase() === "low" && ESCALATION_MODEL) {
    try {
      const better = await callModel(ESCALATION_MODEL, imgBlocks, text);
      return finaliseId(better, ESCALATION_MODEL);
    } catch (e) {
      console.error("escalation failed, keeping default model:", e.message);
    }
  }
  return finaliseId(id, MODEL);
}

// ---- 2. (optional) filtered eBay comps -----------------------------------
let ebayToken = { value: null, exp: 0 };
async function ebayAuth() {
  if (ebayToken.value && Date.now() < ebayToken.exp) return ebayToken.value;
  const basic = Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString("base64");
  const r = await fetchT("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  }, 5000);
  if (!r.ok) throw new Error(`eBay auth ${r.status}`);
  const data = await r.json();
  ebayToken = { value: data.access_token, exp: Date.now() + (data.expires_in - 60) * 1000 };
  return ebayToken.value;
}
const EBAY_FILTER = encodeURIComponent("buyingOptions:{FIXED_PRICE},conditionIds:{3000}"); // used + fixed-price
function okItems(data, ccy) {
  return (data.itemSummaries || []).filter((i) => i.price && i.price.currency === ccy && !isNaN(parseFloat(i.price.value)));
}
async function ebaySearch(query, token, market, ccy) {
  // keyword search: used + fixed-price + clothing category; drop anything not in the marketplace currency.
  const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?limit=50&category_ids=${CLOTHING_CAT}&filter=${EBAY_FILTER}&q=${encodeURIComponent(query)}`;
  const r = await fetchT(url, { headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": market } }, 5000);
  if (!r.ok) throw new Error(`eBay browse ${r.status}`);
  return okItems(await r.json(), ccy);
}
async function ebaySearchByImage(b64, token, market, ccy) {
  // TRUE reverse-image search: eBay ranks active listings by VISUAL similarity to the photo.
  // Same filters so prices stay comparable to the keyword path. Image goes in the POST body (no data: prefix).
  const url = `https://api.ebay.com/buy/browse/v1/item_summary/search_by_image?limit=50&category_ids=${CLOTHING_CAT}&filter=${EBAY_FILTER}`;
  const r = await fetchT(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": market, "content-type": "application/json" },
    body: JSON.stringify({ image: b64 }),
  }, 7000);
  if (!r.ok) throw new Error(`eBay image ${r.status}`);
  return okItems(await r.json(), ccy);
}
// Confidence from evidence: how many comps AND how tight the spread is.
//   high  = 8+ comps AND prices clustered (p10..p90 within 1.5x the median)
//   medium= 3-7 comps, OR 8+ but prices scattered
//   low   = under 3 comps -> treat the number as a guess
function gradeComps(count, low, median, high) {
  const tight = (low != null && median != null && high != null && median > 0) ? (high - low) <= median * 1.5 : false;
  let confidence = "low";
  if (count >= MIN_COMPS) confidence = tight ? "high" : "medium";
  else if (count >= 3) confidence = "medium";
  return { tight, confidence };
}
// fix #2: for a GENERIC (unknown-brand) search, drop obvious outliers before anchoring so a
// few cheap fast-fashion or freak-pricey listings don't drag the percentile. Keep a price only
// if it's within 0.4x..2.5x the raw median, and only if that leaves a reasonable chunk.
function cleanPrices(prices) {
  if (prices.length < 4) return prices;
  const m = pct(prices, 50);
  if (!m) return prices;
  const kept = prices.filter((p) => p >= m * 0.4 && p <= m * 2.5);
  return kept.length >= Math.max(3, Math.ceil(prices.length * 0.5)) ? kept : prices;
}
function summarise(items, ccy, market, used, matched, branded, level, idMeta) {
  // Relevance #1: drop comps whose title doesn't match the item (brand + garment type) BEFORE any maths.
  const rel = idMeta ? filterComps(items, (i) => i.title, idMeta.brand, idMeta.itemType) : { kept: items, total: items.length, dropped: 0, cat: null };
  const matchedTotal = rel.total;
  items = rel.kept;
  if (!items.length) return { source: matched === "image" ? "eBay image match" : "eBay active listings (asking)", visual: matched === "image", marketplace: market, query: used, count: 0, keptOf: matchedTotal, itemCat: rel.cat, currency: ccy, reliable: false, confidence: "low", tight: false, low: null, anchor: null, median: null, high: null, examples: [] };
  let prices = items.map((i) => parseFloat(i.price.value)).sort((a, b) => a - b);
  const rawCount = prices.length;
  if (!branded) prices = cleanPrices(prices);
  const low = pct(prices, 10), median = pct(prices, 50), high = pct(prices, 90);
  // branded: price off the lower third (p30); generic: median of the cleaned set.
  // Part A: a GENERIC item priced off a BROADENED query is a loose match — anchor on p40, not the median.
  const broadened = !!level && level !== "full" && level !== "image";
  const anchor = branded ? pct(prices, 30) : (broadened ? pct(prices, 40) : median);
  // Which comps to SHOW (up to 6, every one a tappable link):
  //  - image match: eBay already ranks by VISUAL similarity, so keep that order (most
  //    similar first) — just skip wild price outliers so a freak listing doesn't headline.
  //  - keyword match: no visual signal, so show the ones priced closest to the anchor.
  let picked;
  if (matched === "image") {
    picked = items.filter((i) => { const v = parseFloat(i.price.value); return v >= anchor * 0.3 && v <= anchor * 3; });
    if (picked.length < 6) picked = items; // filter too aggressive → fall back to raw order
    picked = picked.slice(0, 6);
  } else {
    picked = [...items].sort((a, b) => Math.abs(parseFloat(a.price.value) - anchor) - Math.abs(parseFloat(b.price.value) - anchor)).slice(0, 6);
  }
  const examples = picked.map((i) => ({ title: i.title, price: `${i.price.value} ${i.price.currency}`, url: i.itemWebUrl, image: (i.image && i.image.imageUrl) || null, condition: i.condition || "" }));
  const { tight, confidence } = gradeComps(prices.length, low, median, high);
  return {
    source: matched === "image" ? "eBay image match (visually similar)" : "eBay active listings (asking)",
    visual: matched === "image", marketplace: market, query: used, branded: !!branded,
    count: prices.length, rawCount, keptOf: matchedTotal, itemCat: rel.cat, dropped: rawCount - prices.length, currency: ccy, reliable: prices.length >= MIN_COMPS,
    confidence, tight, low, anchor, median, high, examples,
  };
}
async function getComps(levels, imageB64, branded, idMeta) {
  if (!process.env.EBAY_CLIENT_ID || !process.env.EBAY_CLIENT_SECRET) return null;
  const market = process.env.EBAY_MARKETPLACE || "EBAY_GB";
  const ccy = MARKET_CCY[market] || "GBP";
  const token = await ebayAuth();
  const imageResult = () => { const s = summarise(imageItems, ccy, market, "(image match)", "image", branded, "image", idMeta); s.queryLevel = "image"; return s; };

  // 1) Image search first — matches on how it actually LOOKS, not words.
  let imageItems = [];
  if (imageB64) {
    try { imageItems = await ebaySearchByImage(imageB64, token, market, ccy); }
    catch (e) { console.error("ebay image search:", e.message); }
  }
  // Relevance #1: image match only wins when enough comps survive the title filter
  // (an image match of a shirt that returns dresses/camis is NOT good comps).
  let imgRes = imageItems.length ? imageResult() : null;
  if (imgRes && imgRes.count >= IMG_MIN) return imgRes;

  // 2) Keyword, broadening on thin: full -> drop material -> drop colour. First with >=MIN wins; else the best.
  let best = null, bestLevel = null, bestQ = "";
  for (const { level, q } of (levels || [])) {
    if (!q) continue;
    let items; try { items = await ebaySearch(q, token, market, ccy); } catch (e) { console.error("ebay kw", level, e.message); continue; }
    if (!best || items.length > best.length) { best = items; bestLevel = level; bestQ = q; }
    if (items.length >= MIN_COMPS) { best = items; bestLevel = level; bestQ = q; break; }
  }
  let kwRes = null;
  if (best && best.length) {
    kwRes = summarise(best, ccy, market, bestQ, "keyword", branded, bestLevel, idMeta);
    kwRes.queryLevel = bestLevel;
  }
  // Pick whichever yields more RELEVANT comps after the title filter (not raw count).
  if (kwRes && imgRes) return (imgRes.count >= kwRes.count) ? imgRes : kwRes;
  return kwRes || imgRes || null;
}

// NOTE: Google Vision reverse image search lives in api/web.js now — it's an
// on-demand button, not part of every scan, so no auto-cost or weak labels.

// ---- handler -------------------------------------------------------------
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

    // --- auth (before any work / cost) ---
    if (!process.env.FLIPSCAN_SECRET) return res.status(500).json({ error: "server_misconfigured" });
    if ((req.headers["x-flipscan-secret"] || "") !== process.env.FLIPSCAN_SECRET)
      return res.status(401).json({ error: "unauthorized" });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "server_misconfigured" });

    const body = await readJson(req);

    // --- validate images ---
    let list = (body.images && body.images.length) ? body.images : (body.image ? [body.image] : []);
    if (!list.length) return res.status(400).json({ error: "no_image" });
    if (list.length > MAX_IMAGES) return res.status(400).json({ error: "too_many_images", max: MAX_IMAGES });
    let total = 0;
    const parsed = [];
    for (const d of list) {
      if (typeof d !== "string") return res.status(400).json({ error: "bad_image" });
      if (d.length > MAX_IMG_CHARS) return res.status(413).json({ error: "image_too_large" });
      total += d.length;
      const p = parseDataUrl(d);
      if (!p) return res.status(400).json({ error: "bad_image_format" });
      parsed.push(p);
    }
    if (total > MAX_TOTAL_CHARS) return res.status(413).json({ error: "payload_too_large" });

    const note = String(body.note || "").trim().slice(0, 200);

    // --- identify ---
    let identity;
    try { identity = await identify(parsed, note); }
    catch (e) {
      console.error("identify error:", e.stage, e.message);
      return res.status(502).json({ error: e.stage || "identify_failed" });
    }

    // --- comps (optional; never fails the scan). eBay image → keyword fallback. ---
    let comps = null;
    try {
      const branded = !!(identity.brand && identity.brand.toLowerCase() !== "unknown");
      comps = await getComps(buildQueryLevels(identity), parsed[0] && parsed[0].b64, branded, { brand: identity.brand, itemType: identity.item_type });
    } catch (e) {
      console.error("comps error:", e.message);
      comps = { error: "comps_failed" };
    }

    return res.status(200).json({ identity, comps });
  } catch (e) {
    console.error("handler error:", e);
    return res.status(500).json({ error: "server_error" });
  }
}
