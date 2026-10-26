// FlipScan — hand-coded comp relevance map. FALLBACK ONLY: the generic LLM judge
// (lib/judge.js) is the primary relevance filter now. This runs only if the judge call
// fails or times out. `classify` is also still used for football detection + the Vinted
// catalog[] filter. Don't grow these categories — fix relevance in the judge's prompt instead.
// A comp counts only if its TITLE matches: brand (when known) AND garment type, no mismatch.

// Ordered: the FIRST category whose key word appears in the item_type wins (so "cargo shorts"
// is shorts, not jeans; "football jersey" is a shirt, not a generic top).
const CATS = [
  { id: "football_shirt", keys: ["football", "soccer", "jersey", "kit"],
    syn: ["shirt", "jersey", "top", "kit", "tee", "tshirt"],
    reject: ["dress", "cami", "camisole", "shorts", "jacket", "coat", "blazer", "bomber", "jeans", "trousers", "trouser", "skirt", "hoodie", "sweatshirt", "jumper", "sweater", "cardigan", "bag", "scarf", "hat", "socks", "boots", "gloves"] },
  { id: "shorts", keys: ["shorts"],
    syn: ["shorts"],
    reject: ["dress", "jersey", "jacket", "coat", "jeans", "trousers", "skirt", "jumper", "sweatshirt", "hoodie", "cardigan", "blouse"] },
  { id: "jeans", keys: ["jeans", "denim", "trouser", "trousers", "pants", "chino", "chinos", "cargo", "jogger", "joggers", "legging", "leggings"],
    syn: ["jeans", "denim", "trousers", "trouser", "pants", "chino", "chinos", "cargo", "cargos", "jogger", "joggers", "legging", "leggings"],
    reject: ["dress", "jersey", "jacket", "coat", "skirt", "shorts", "hoodie", "sweatshirt", "jumper", "blouse"] },
  { id: "jacket", keys: ["jacket", "coat", "blazer", "bomber", "gilet", "parka", "anorak", "windbreaker", "overcoat"],
    syn: ["jacket", "coat", "blazer", "bomber", "gilet", "parka", "anorak", "windbreaker", "overcoat"],
    reject: ["dress", "jersey", "jeans", "trousers", "skirt", "shorts", "blouse"] },
  { id: "knit", keys: ["jumper", "sweatshirt", "sweater", "hoodie", "pullover", "cardigan", "fleece", "crewneck"],
    syn: ["jumper", "sweatshirt", "sweater", "hoodie", "pullover", "cardigan", "fleece", "crewneck", "sweat"],
    reject: ["dress", "jeans", "trousers", "skirt", "shorts", "jacket", "coat", "blazer"] },
  { id: "dress", keys: ["dress", "gown", "frock"],
    syn: ["dress", "gown", "frock"],
    reject: ["shirt", "jersey", "jeans", "trousers", "jacket", "coat", "shorts", "skirt", "jumper", "hoodie", "sweatshirt", "blazer", "cami"] },
  { id: "skirt", keys: ["skirt"],
    syn: ["skirt"],
    reject: ["jeans", "trousers", "dress", "jersey", "jacket", "coat", "shorts", "jumper", "hoodie", "sweatshirt"] },
  { id: "cami", keys: ["cami", "camisole"],
    syn: ["cami", "camisole", "tank", "vest"],
    reject: ["jeans", "trousers", "jacket", "coat", "dress", "shorts", "skirt", "jumper", "hoodie", "sweatshirt", "jersey"] },
  { id: "shirt", keys: ["shirt", "blouse", "polo", "tee", "top"],
    syn: ["shirt", "blouse", "polo", "tee", "tshirt", "top"],
    reject: ["dress", "jeans", "trousers", "jacket", "coat", "shorts", "skirt", "jumper", "hoodie", "sweatshirt", "cardigan"] },
];

function norm(s) { return " " + String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim() + " "; }
// whole-word (token) match so "shorts" never matches "short-sleeve", "star" never matches "starter".
function hasWord(normStr, tok) { return normStr.indexOf(" " + tok + " ") !== -1; }

function classify(itemType) {
  const t = norm(itemType);
  for (const c of CATS) { if (c.keys.some((k) => hasWord(t, k))) return c; }
  return null; // couldn't classify -> brand-only filtering
}

function brandWords(brand) {
  const b = String(brand || "").toLowerCase();
  if (!b || b === "unknown") return [];
  const words = b.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  return words.length ? words : (b.length >= 2 ? [b] : []);
}

// Keep a single comp? title must carry the brand (when known) + the garment type, and no mismatch.
function keepComp(title, brand, cat) {
  const t = norm(title);
  if (!t.trim()) return false;
  const bw = brandWords(brand);
  if (bw.length && !bw.some((w) => hasWord(t, w))) return false;       // brand known -> must appear
  if (cat) {
    if (!cat.syn.some((w) => hasWord(t, w))) return false;             // must match the garment type
    if (cat.reject.some((w) => hasWord(t, w))) return false;           // must not name a different garment
  }
  return true;
}

// Filter a list of comps. getTitle(item)->string. Returns {kept, total, dropped, cat}.
function filterComps(items, getTitle, brand, itemType) {
  const cat = classify(itemType);
  const total = items.length;
  const kept = items.filter((it) => keepComp(getTitle(it), brand, cat));
  return { kept, total, dropped: total - kept.length, cat: cat ? cat.id : null };
}

export { classify, keepComp, filterComps, brandWords };
