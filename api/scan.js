// FlipScan — serverless function (Vercel, Node 18+ runtime, ESM).
// Accepts one OR several photos of a SINGLE item (multiple angles/labels = richer ID).
// To scan several DIFFERENT items, the client sends one request per item.
// Flow: photo(s) -> Claude Haiku vision -> (optional) eBay Browse comps -> JSON.

const MODEL = "claude-haiku-4-5-20251001"; // swap if you prefer another vision model

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
function parseModelJson(text) {
  const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = cleaned.indexOf("{"); const end = cleaned.lastIndexOf("}");
  return JSON.parse(cleaned.slice(start, end + 1));
}
function parseDataUrl(dataUrl) {
  const m = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl);
  return { mediaType: m ? m[1] : "image/jpeg", b64: m ? m[2] : dataUrl };
}

// ---- 1. identify the item with Claude (uses all supplied photos) ---------
async function identify(images, note) {
  const imgBlocks = images.map((im) => ({
    type: "image", source: { type: "base64", media_type: im.mediaType, data: im.b64 },
  }));
  const prompt =
`You are an expert vintage-clothing identifier helping a reseller price an item.
You may be given SEVERAL photos of the SAME item (different angles and its labels) — use them all together.

Work carefully and AVOID these common mistakes that cost resellers money:
1. TYPE from silhouette: it's usually ONE garment, often folded, flat-laid or styled. Don't mistake folded sleeves for trouser legs, a flat-laid top for a skirt, a cropped hem hidden by a fold for a full-length top, or a two-piece set for a single item. Judge the type from the collar, neckline, cuffs, buttons, zips and hems — not the outline. An open front could be a cardigan, zip-hoodie or jacket — check before deciding.
2. BRAND vs PRINT: the real brand is on the NECK/CARE LABEL. A logo, band, cartoon, team or slogan printed on the fabric is the DESIGN, not the maker (e.g. a Primark tee with a Nike graphic is NOT Nike). If you can't see a maker's label, set "brand" to "unknown" and put the graphic in "key_features".
3. VINTAGE vs MODERN REPRO: don't call it vintage unless label style, stitching, fabric-content wording or a "made in" cue supports it — lots of Y2K/90s-looking pieces are new fast fashion. If unsure, use "unknown" or "modern repro?" for era.
4. SIZE: only state a size you can actually READ on the label. Never infer it from the photo — with no scale it could even be kids' sizing; flag that if relevant.
5. CONDITION: creases, shadows and folds are NOT flaws. Only flag stains, holes, pilling or fading you can clearly see.
6. MATERIAL: don't assert silk, leather, wool or real fur from looks alone — satin polyester mimics silk, PU mimics leather, faux mimics fur. Say "looks like X" or defer to the label.
7. IGNORE the background, hanger, mannequin, hands and reflections — identify only the garment.
8. If the type or brand is genuinely ambiguous, describe what you can see and set "confidence" to "low" rather than guess.

Return ONLY a JSON object (no prose, no markdown) with these keys:
"brand" (best guess, or "unknown"),
"item_type" (e.g. "long-sleeve floral top","track jacket","fair isle jumper"; include the sleeve length for tops when you can tell — short/long/3-4 sleeve),
"era" (e.g. "1990s","Y2K","2000s","unknown"),
"key_features" (short: colour, pattern, notable details),
"size" (from the label if visible, else "unknown"),
"condition_notes" (any visible flaws),
"notes" (ONE short sentence of resale insight — what drives its value, what to double-check, or why it's desirable),
"search_query" (a concise eBay-style search string to find comparable SOLD listings — brand + item + era + key descriptor, no filler),
"authenticity_flags" (a short note if anything looks fake/bootleg, else "none"),
"confidence" ("high","medium" or "low"),
"estimated_resale_eur" (an object {"low": integer, "high": integer} — your best estimate of the secondhand resale price range in EUR on Vinted/Depop/eBay in good condition; best-effort rough guide only).`
    + (note ? `\nSeller note: ${note}` : "");

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 600,
      temperature: 0, // deterministic — same photo gives the same read, not a different guess each scan
      messages: [{ role: "user", content: [...imgBlocks, { type: "text", text: prompt }] }],
    }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const text = (data.content || []).map((b) => b.text || "").join("");
  return parseModelJson(text);
}

// ---- 2. (optional) eBay comparable listings ------------------------------
let ebayToken = { value: null, exp: 0 };
async function ebayAuth() {
  if (ebayToken.value && Date.now() < ebayToken.exp) return ebayToken.value;
  const basic = Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString("base64");
  const r = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  });
  if (!r.ok) throw new Error(`eBay auth ${r.status}: ${await r.text()}`);
  const data = await r.json();
  ebayToken = { value: data.access_token, exp: Date.now() + (data.expires_in - 60) * 1000 };
  return ebayToken.value;
}
async function getComps(query) {
  if (!process.env.EBAY_CLIENT_ID || !process.env.EBAY_CLIENT_SECRET) return null;
  const token = await ebayAuth();
  const market = process.env.EBAY_MARKETPLACE || "EBAY_GB";
  const url = "https://api.ebay.com/buy/browse/v1/item_summary/search?limit=50&q=" + encodeURIComponent(query);
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": market } });
  if (!r.ok) throw new Error(`eBay browse ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const items = data.itemSummaries || [];
  const prices = items.map((i) => parseFloat(i.price && i.price.value)).filter((n) => !isNaN(n)).sort((a, b) => a - b);
  const currency = (items[0] && items[0].price && items[0].price.currency) || "GBP";
  const examples = items.slice(0, 4).map((i) => ({
    title: i.title, price: i.price ? `${i.price.value} ${i.price.currency}` : "—",
    url: i.itemWebUrl, image: (i.image && i.image.imageUrl) || null, condition: i.condition || "",
  }));
  return { source: "eBay active listings (asking)", count: prices.length, currency,
    low: pct(prices, 10), median: pct(prices, 50), high: pct(prices, 90), examples };
}

// ---- handler -------------------------------------------------------------
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

    const body = await readJson(req);
    const list = (body.images && body.images.length) ? body.images : (body.image ? [body.image] : []);
    if (!list.length) return res.status(400).json({ error: "No image provided" });

    const parsed = list.slice(0, 5).map(parseDataUrl); // cap at 5 photos per item
    const identity = await identify(parsed, body.note);

    let comps = null;
    try { comps = await getComps(identity.search_query || `${identity.brand} ${identity.item_type}`); }
    catch (e) { comps = { error: String(e.message || e) }; }

    return res.status(200).json({ identity, comps });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
