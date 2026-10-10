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
IMPORTANT: it is almost always a SINGLE garment that may be folded, flat-laid, or styled — e.g. a top with its sleeves folded across the front to show the pattern. Do NOT mistake folded sleeves for trouser legs. Decide the garment type from the collar, neckline, cuffs, buttons, hems and labels, not just the overall silhouette. If the type is genuinely ambiguous, describe what you can actually see and set "confidence" to "low" rather than guessing a specific wrong type.
Return ONLY a JSON object (no prose, no markdown) with these keys:
"brand" (best guess, or "unknown"),
"item_type" (e.g. "track jacket","fair isle jumper","Carhartt hoodie"),
"era" (e.g. "1990s","Y2K","2000s","unknown"),
"key_features" (short: colour, pattern, notable details),
"size" (from the label if visible, else "unknown"),
"condition_notes" (any visible flaws),
"notes" (ONE short sentence of resale insight — what drives its value, what to double-check, or why it's desirable),
"search_query" (a concise eBay-style search string to find comparable SOLD listings — brand + item + era + key descriptor, no filler),
"authenticity_flags" (a short note if anything looks fake/bootleg, else "none"),
"confidence" ("high","medium" or "low").`
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
