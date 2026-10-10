// FlipScan — serverless function (Vercel, Node 18+ runtime, ESM).
// Flow: photo (base64) -> Claude Haiku vision IDs the item -> (optional) eBay Browse
// pulls comparable listings -> returns { identity, comps }.
// Keys never touch the browser; set them as Vercel Environment Variables.

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

// strip ```json fences if the model adds them, then parse
function parseModelJson(text) {
  const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  return JSON.parse(cleaned.slice(start, end + 1));
}

// ---- 1. identify the item with Claude -----------------------------------
async function identify(imageBase64, mediaType, note) {
  const prompt =
`You are an expert vintage-clothing identifier helping a reseller price an item.
The photo may show the garment and/or its labels. Identify it for resale comping.
Return ONLY a JSON object (no prose, no markdown) with these keys:
"brand" (best guess, or "unknown"),
"item_type" (e.g. "track jacket","fair isle jumper","Carhartt hoodie"),
"era" (e.g. "1990s","Y2K","2000s","unknown"),
"key_features" (short: colour, pattern, notable details),
"size" (from the label if visible, else "unknown"),
"condition_notes" (any visible flaws),
"search_query" (a concise eBay-style search string to find comparable SOLD listings — brand + item + era + key descriptor, no filler words),
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
      max_tokens: 500,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
          { type: "text", text: prompt },
        ],
      }],
    }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const text = (data.content || []).map((b) => b.text || "").join("");
  return parseModelJson(text);
}

// ---- 2. (optional) eBay comparable listings ------------------------------
// NOTE: eBay Browse returns ACTIVE listings (asking prices), not sold. It's a
// solid, free, legit price signal. To upgrade to true SOLD comps, swap this
// function for eBay's Marketplace Insights API or a sold-comps provider — the
// rest of the app doesn't change.
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
  if (!process.env.EBAY_CLIENT_ID || !process.env.EBAY_CLIENT_SECRET) return null; // graceful: no comps yet
  const token = await ebayAuth();
  const market = process.env.EBAY_MARKETPLACE || "EBAY_GB";
  const url =
    "https://api.ebay.com/buy/browse/v1/item_summary/search?limit=50&q=" + encodeURIComponent(query);
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": market },
  });
  if (!r.ok) throw new Error(`eBay browse ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const items = data.itemSummaries || [];
  const prices = items.map((i) => parseFloat(i.price && i.price.value)).filter((n) => !isNaN(n)).sort((a, b) => a - b);
  const currency = (items[0] && items[0].price && items[0].price.currency) || "GBP";
  const examples = items.slice(0, 4).map((i) => ({
    title: i.title,
    price: i.price ? `${i.price.value} ${i.price.currency}` : "—",
    url: i.itemWebUrl,
    image: (i.image && i.image.imageUrl) || null,
    condition: i.condition || "",
  }));
  return {
    source: "eBay active listings (asking prices)",
    count: prices.length,
    currency,
    low: pct(prices, 10),
    median: pct(prices, 50),
    high: pct(prices, 90),
    examples,
  };
}

// ---- handler -------------------------------------------------------------
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

    const { image, note } = await readJson(req);
    if (!image) return res.status(400).json({ error: "No image provided" });

    // image is a data URL: data:image/jpeg;base64,xxxx
    const m = /^data:(image\/\w+);base64,(.+)$/.exec(image);
    const mediaType = m ? m[1] : "image/jpeg";
    const b64 = m ? m[2] : image;

    const identity = await identify(b64, mediaType, note);

    let comps = null;
    try { comps = await getComps(identity.search_query || `${identity.brand} ${identity.item_type}`); }
    catch (e) { comps = { error: String(e.message || e) }; } // don't fail the whole scan if comps break

    return res.status(200).json({ identity, comps });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
