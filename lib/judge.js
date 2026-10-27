// FlipScan — generic LLM relevance judge for comps (replaces hand-written category rules).
// Each source endpoint runs: codeFilter (brand/bundle/price, universal) -> judgeComps (ONE Haiku
// call, "same kind of item?") -> prices from the survivors. The category map (lib/relevance.js)
// is only a FALLBACK if the judge call fails or times out (6s). Results cached 24h by id+titles.

import { filterComps as categoryFilter, brandWords } from "./relevance.js";

const JUDGE_MODEL = process.env.JUDGE_MODEL || "claude-haiku-4-5-20251001";
const JUDGE_MS = 6000;
const CACHE_TTL = 86400;
const MAX_JUDGE = 100;  // cap titles per call (keeps it under 6s; 240 sold titles timed out)
const BUNDLE_RE = /\b(?:job\s?lot|joblot|bundle|bulk|wholesale|multipack|multi\s?pack|x\s?\d+|\d+\s?x|\d+\s?pcs|set of|pack of|lot of|pair of|\bjob\b)\b/i;

function fetchT(url, opts, ms) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(t));
}
async function redisCmd(cmd) {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  try {
    const r = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(cmd),
    });
    if (!r.ok) return null;
    return (await r.json()).result;
  } catch { return null; }
}
function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
function norm(s) { return " " + String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim() + " "; }

// Universal CODE filters (no taxonomy): brand must appear (when known), no bundles, price sane.
function codeFilter(items, getTitle, getPrice, brand) {
  const bw = brandWords(brand);
  const prices = items.map(getPrice).filter((n) => isFinite(n) && n > 0).sort((a, b) => a - b);
  const rawMed = prices.length ? prices[Math.floor(prices.length / 2)] : null;
  const kept = [], drops = [];
  for (const it of items) {
    const title = String(getTitle(it) || ""), t = norm(title), p = getPrice(it);
    if (bw.length && !bw.some((w) => t.indexOf(" " + w + " ") !== -1)) { drops.push({ title, reason: "brand mismatch" }); continue; }
    if (BUNDLE_RE.test(title)) { drops.push({ title, reason: "bundle/job lot" }); continue; }
    if (isFinite(p) && p > 0 && (p < 1 || (rawMed && p > rawMed * 20))) { drops.push({ title, reason: "price outlier" }); continue; }
    kept.push(it);
  }
  return { kept, drops };
}

// We ask for the DROPS only (keep = everything else) — far fewer output tokens, so it's faster.
const JUDGE_TOOL = {
  name: "relevance",
  description: "Report which numbered comp titles to DROP (not the same kind of item to price against).",
  input_schema: {
    type: "object",
    properties: {
      drops: { type: "array", description: "Indices to DROP. Keep everything you do not list here.", items: { type: "object", properties: { i: { type: "integer" }, reason: { type: "string", description: "3 words max, e.g. 'different garment', 'club shirt', 'kids size', 'bundle', 'premium tier'." } }, required: ["i", "reason"] } },
    },
    required: ["drops"],
  },
};

async function judgeComps(identity, items, getTitle) {
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false };
  if (!items.length) return { ok: true, keep: new Set(), drops: [], inTok: 0, outTok: 0 };
  const idLine = [
    identity.brand && `brand: ${identity.brand}`, identity.item_type && `type: ${identity.item_type}`,
    identity.colour && `colour: ${identity.colour}`, identity.material && `material: ${identity.material}`,
    identity.club && `club: ${identity.club}`, identity.key_features && `features: ${identity.key_features}`,
  ].filter(Boolean).join("; ");
  const numbered = items.map((it, i) => `${i}. ${String(getTitle(it) || "").slice(0, 120)}`).join("\n");
  const prompt =
`We are pricing this second-hand clothing item:
${idLine}

Below are numbered comparable-listing TITLES. We KEEP a title when it's the SAME KIND of item to price against: the same garment type AND the same market tier (don't mix a plain high-street top with premium/branded ones).
DROP a title when it is: a different garment type; a club/kit football shirt when OUR item has no club named above; kids'/children's sizes for an adult item; a bundle/job-lot/multipack; an accessory (bag, socks, scarf, hat). When genuinely unsure, drop it.

${numbered}

Call the relevance tool with ONLY the indices to DROP (each with a 3-word reason). Everything you don't list is kept.`;
  try {
    const r = await fetchT("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: JUDGE_MODEL, max_tokens: 1500, temperature: 0, tools: [JUDGE_TOOL], tool_choice: { type: "tool", name: "relevance" }, messages: [{ role: "user", content: prompt }] }),
    }, JUDGE_MS);
    if (!r.ok) { console.error("judge http", r.status); return { ok: false }; }
    const data = await r.json();
    const block = (data.content || []).find((b) => b.type === "tool_use");
    if (!block || !block.input) return { ok: false };
    const dropIdx = new Set((block.input.drops || []).filter((d) => Number.isInteger(d.i) && d.i >= 0 && d.i < items.length).map((d) => d.i));
    const keep = new Set(items.map((_, i) => i).filter((i) => !dropIdx.has(i)));  // keep = everything not dropped
    const drops = (block.input.drops || [])
      .filter((d) => Number.isInteger(d.i) && items[d.i])
      .map((d) => ({ title: String(getTitle(items[d.i]) || ""), reason: String(d.reason || "").slice(0, 40) }));
    const u = data.usage || {};
    return { ok: true, keep, drops, inTok: u.input_tokens || 0, outTok: u.output_tokens || 0 };
  } catch (e) { console.error("judge call", e.message); return { ok: false }; }
}

// Full pipeline for one source's comps. identity: {brand,item_type,colour,material,club,key_features}.
// Returns { kept, total, drops:[{title,reason}], judge:{ms,cached,fallback,inTok,outTok} }.
export async function judgeFilter(identity, items, getTitle, getPrice, scope) {
  const t0 = Date.now();
  const rawTotal = items.length;
  const { kept: codedAll, drops: codeDrops } = codeFilter(items, getTitle, getPrice, identity && identity.brand);
  // Cap titles sent to the judge so the call stays under 6s (240 sold titles timed out). A sample
  // of up to MAX_JUDGE relevant comps is plenty for a median; `total` = what the judge actually saw.
  const coded = codedAll.length > MAX_JUDGE ? codedAll.slice(0, MAX_JUDGE) : codedAll;
  const total = coded.length;
  if (!coded.length) return { kept: [], total, rawTotal, drops: codeDrops, judge: { ms: 0, cached: false, fallback: false, inTok: 0, outTok: 0, judged: rawTotal > 0 } };

  const key = `flipscan:judge:v2:${scope}:${hash((identity.brand || "") + "~" + (identity.item_type || "") + "~" + coded.map((it) => getTitle(it)).join("|"))}`;
  const cachedRaw = await redisCmd(["GET", key]);
  if (cachedRaw) {
    try {
      const c = JSON.parse(cachedRaw);
      const keep = new Set(c.keep || []);
      const kept = coded.filter((_, i) => keep.has(i));
      return { kept, total, rawTotal, drops: codeDrops.concat(c.drops || []), judge: { ms: 0, cached: true, fallback: false, inTok: 0, outTok: 0, judged: true } };
    } catch { /* fall through to a fresh judge */ }
  }

  const j = await judgeComps(identity, coded, getTitle);
  if (j.ok) {
    const kept = coded.filter((_, i) => j.keep.has(i));
    redisCmd(["SET", key, JSON.stringify({ keep: [...j.keep], drops: j.drops }), "EX", String(CACHE_TTL)]).catch(() => {});
    return { kept, total, rawTotal, drops: codeDrops.concat(j.drops), judge: { ms: Date.now() - t0, cached: false, fallback: false, inTok: j.inTok, outTok: j.outTok, judged: true } };
  }
  // Fallback: the hand-written category map, on the code-filtered survivors.
  const rel = categoryFilter(coded, getTitle, identity && identity.brand, identity && identity.item_type);
  return { kept: rel.kept, total, rawTotal, drops: codeDrops, judge: { ms: Date.now() - t0, cached: false, fallback: true, inTok: 0, outTok: 0, judged: false } };
}
