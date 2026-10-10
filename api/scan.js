// FlipScan — serverless function (Vercel, Node 18+ runtime, ESM, zero deps).
// Flow: photo(s) -> Claude Haiku (forced tool-call -> structured identity)
//       -> (optional) filtered eBay comps -> one JSON response { identity, comps }.
// A comps failure never fails the whole scan. Secrets stay server-side.

const MODEL = "claude-haiku-4-5-20251001";
// const ESCALATION_MODEL = "claude-sonnet-5"; // deferred: see DOCS §13/§15. Low confidence is
// usually a bad photo (no label) — a stronger model won't fix that, so we nudge for a label shot
// instead. Enable + wire up once the accuracy test set proves it earns the cost.

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
8. If the type or brand is genuinely ambiguous, describe what you can see and set "confidence" to "low" rather than guess.`;

const IDENTITY_TOOL = {
  name: "report_item",
  description: "Report the identification of the clothing item for resale pricing.",
  input_schema: {
    type: "object",
    properties: {
      brand: { type: "string", description: "Maker from the neck/care label, or 'unknown'. NOT a printed graphic." },
      item_type: { type: "string", description: "e.g. 'long-sleeve floral top','track jacket'. Include sleeve length for tops when visible." },
      era: { type: "string", description: "'1990s','Y2K','2000s','unknown', or 'modern repro?'." },
      key_features: { type: "string", description: "Colour, pattern, notable details, any printed graphic." },
      size: { type: "string", description: "Only if readable on the label, else 'unknown'." },
      condition_notes: { type: "string", description: "Visible flaws only (stains/holes/pilling/fading)." },
      notes: { type: "string", description: "One short, plain line like a mate would say — what makes it worth money, or what to double-check. Everyday words only; NO marketing speak (avoid 'appeals to buyers', 'nostalgia', 'sought-after', 'coveted')." },
      search_query: { type: "string", description: "SHORT eBay-style search to find MANY comparable sold listings: about 3-5 words — brand + item type + at most ONE key descriptor. Drop colour, era and extra adjectives; a long/specific string matches too few listings. No 'unknown', no filler." },
      authenticity_flags: { type: "string", description: "Short note if anything looks fake/bootleg, else 'none'." },
      confidence: { type: "string", enum: ["high", "medium", "low"], description: "Overall confidence in the identification." },
      estimated_resale_eur: {
        type: "object",
        description: "Best estimate of the realistic secondhand price range, in EUR, on the stated platform for a buyer in Ireland, in the ACTUAL condition visible in the photos.",
        properties: { low: { type: "number" }, high: { type: "number" } },
        required: ["low", "high"],
      },
    },
    required: ["brand", "item_type", "era", "search_query", "confidence", "estimated_resale_eur"],
  },
};

function cleanEstimate(e) {
  if (!e) return null;
  let lo = Number(e.low), hi = Number(e.high);
  if (!isFinite(lo) || !isFinite(hi) || lo <= 0 || hi <= 0) return null;
  if (lo > hi) [lo, hi] = [hi, lo];
  return { low: Math.round(lo), high: Math.round(hi) };
}

async function identify(images, note) {
  const platform = process.env.SELL_PLATFORM || "Vinted";
  const imgBlocks = images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.mediaType, data: im.b64 } }));
  const text =
`You are an expert vintage-clothing identifier helping a reseller price an item. You may be given SEVERAL photos of the SAME item (different angles and its labels) — use them all together.

${RULES}

For "estimated_resale_eur", give the realistic secondhand price on ${platform} for a buyer in Ireland, in the condition actually visible in the photos.
Call the report_item tool with your assessment.`;

  let r;
  try {
    r = await fetchT("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL, max_tokens: 1000, temperature: 0,
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
  const id = block.input;
  id.estimated_resale_eur = cleanEstimate(id.estimated_resale_eur);
  id.model_used = MODEL;
  return id;
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
function summarise(items, ccy, market, used, matched) {
  if (!items.length) return { source: matched === "image" ? "eBay image match" : "eBay active listings (asking)", visual: matched === "image", marketplace: market, query: used, count: 0, currency: ccy, reliable: false, low: null, anchor: null, median: null, high: null, examples: [] };
  const prices = items.map((i) => parseFloat(i.price.value)).sort((a, b) => a - b);
  const anchor = pct(prices, 30);
  // examples: the 4 listings priced closest to the anchor
  const examples = [...items].sort((a, b) => Math.abs(parseFloat(a.price.value) - anchor) - Math.abs(parseFloat(b.price.value) - anchor))
    .slice(0, 4).map((i) => ({ title: i.title, price: `${i.price.value} ${i.price.currency}`, url: i.itemWebUrl, image: (i.image && i.image.imageUrl) || null, condition: i.condition || "" }));
  return {
    source: matched === "image" ? "eBay image match (visually similar)" : "eBay active listings (asking)",
    visual: matched === "image", marketplace: market, query: used,
    count: prices.length, currency: ccy, reliable: prices.length >= MIN_COMPS,
    low: pct(prices, 10), anchor, median: pct(prices, 50), high: pct(prices, 90), examples,
  };
}
async function getComps(cleanedQuery, fallbackQuery, imageB64) {
  if (!process.env.EBAY_CLIENT_ID || !process.env.EBAY_CLIENT_SECRET) return null;
  const market = process.env.EBAY_MARKETPLACE || "EBAY_GB";
  const ccy = MARKET_CCY[market] || "GBP";
  const token = await ebayAuth();

  // 1) Try TRUE image search first — matches on how the item actually LOOKS, not words.
  let imageItems = [];
  if (imageB64) {
    try { imageItems = await ebaySearchByImage(imageB64, token, market, ccy); }
    catch (e) { console.error("ebay image search:", e.message); }
  }
  if (imageItems.length >= IMG_MIN) return summarise(imageItems, ccy, market, "(image match)", "image");

  // 2) Fall back to keyword search (with a broader retry) when image search is unavailable or too thin.
  if (!cleanedQuery) return imageItems.length ? summarise(imageItems, ccy, market, "(image match)", "image") : null;
  let used = cleanedQuery;
  let items = await ebaySearch(cleanedQuery, token, market, ccy);
  if (items.length < MIN_COMPS && fallbackQuery && cleanQuery(fallbackQuery) && cleanQuery(fallbackQuery) !== cleanedQuery) {
    const broader = await ebaySearch(cleanQuery(fallbackQuery), token, market, ccy);
    if (broader.length > items.length) { items = broader; used = cleanQuery(fallbackQuery); }
  }
  // If keyword also came back thin but image had a few, prefer the visual matches.
  if (imageItems.length > items.length) return summarise(imageItems, ccy, market, "(image match)", "image");
  return summarise(items, ccy, market, used, "keyword");
}

// ---- 3. (optional) Google Vision web detection = reverse image search ----
// Finds the SAME item across the whole web — brand site, boutiques, vintage shops,
// other marketplaces — by matching the photo itself. Takes base64 directly; cheap.
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } }
async function webDetect(b64) {
  if (!process.env.GOOGLE_VISION_API_KEY || !b64) return null;
  let r;
  try {
    r = await fetchT(`https://vision.googleapis.com/v1/images:annotate?key=${process.env.GOOGLE_VISION_API_KEY}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requests: [{ image: { content: b64 }, features: [{ type: "WEB_DETECTION", maxResults: 12 }] }] }),
    }, 7000);
  } catch (e) { console.error("vision timeout:", e.message); return null; }
  if (!r.ok) { console.error("vision:", r.status, await r.text().catch(() => "")); return null; }
  const w = (((await r.json()).responses || [])[0] || {}).webDetection || {};
  const best = (w.bestGuessLabels || [])[0]?.label || null;
  const entities = (w.webEntities || []).filter((e) => e.description && e.score > 0.2).slice(0, 5).map((e) => e.description);
  const raw = (w.pagesWithMatchingImages || [])
    .map((p) => ({ title: p.pageTitle || hostOf(p.url), url: p.url, site: hostOf(p.url), full: (p.fullMatchingImages || []).length > 0 }))
    .filter((p) => p.url && p.site);
  raw.sort((a, b) => (b.full ? 1 : 0) - (a.full ? 1 : 0)); // exact-image matches first
  const seen = new Set(), pages = [];
  for (const p of raw) { if (seen.has(p.site)) continue; seen.add(p.site); pages.push(p); if (pages.length >= 8) break; } // one per site = variety
  if (!best && !pages.length && !entities.length) return null;
  return { best_guess: best, entities, pages };
}

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

    // --- comps + web sources (optional; neither failure fails the scan) ---
    const cq = cleanQuery(identity.search_query);
    const primary = parsed[0] && parsed[0].b64;  // primary photo drives both image searches
    const [compsR, webR] = await Promise.allSettled([
      getComps(cq, `${identity.brand} ${identity.item_type}`, primary),   // eBay (image → keyword)
      webDetect(primary),                                                 // Google Vision reverse image
    ]);
    const comps = compsR.status === "fulfilled" ? compsR.value : (console.error("comps error:", compsR.reason?.message), { error: "comps_failed" });
    const web = webR.status === "fulfilled" ? webR.value : null;

    return res.status(200).json({ identity, comps, web });
  } catch (e) {
    console.error("handler error:", e);
    return res.status(500).json({ error: "server_error" });
  }
}
