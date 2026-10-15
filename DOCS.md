# FlipScan — How it works (full reference)

> Point a phone camera at a secondhand clothing item → an AI reads what it is →
> you get a resale price read + a buy/pass verdict + one-tap links to check the
> real market. Built for sourcing (charity shops, car boots, kilo sales) where
> you need to decide *"is this worth buying?"* in a few seconds.

This is the deep-dive. For the 10-minute "just deploy it" version, see `README.md`.

---

## 1. What it is, in one breath
A tiny web app (one page + one serverless function) hosted on Vercel. It turns a
photo into: **identity** (brand, type, era, flaws, fake-flags), a **price read**,
and a **verdict** against what you paid. It is a *decision tool*, not an inventory
or listing tool — it answers one question: *should I buy this to flip it?*

## 2. The problem it solves
Sourcing is a speed game. The margin is made at the **buy**, not the sell — so the
skill is knowing, in the moment, roughly what a thing resells for. Doing that
manually means squinting at a label, then searching eBay/Vinted/Depop one by one.
FlipScan compresses that into: snap → read → decide.

---

## 3. The end-to-end flow

```
  [ Phone ]                         [ Vercel serverless /api/scan ]            [ External ]
  ─────────                         ──────────────────────────────            ──────────
  take / pick photo(s)
  shrink to ~1024px  ──POST JSON──▶ parse image(s)
                                    │
                                    ├─▶ Anthropic API (Claude Haiku, vision) ──▶ identity JSON
                                    │        "what is this + resale estimate"
                                    │
                                    └─▶ eBay Browse API (if keys set) ────────▶ comparable prices
                                             "median + range + examples"
                                    │
  render result  ◀──JSON {identity, comps}──┘
  type "what you paid" ─▶ live verdict (no server call)
  tap eBay/Vinted/Depop ─▶ real listings in a new tab (manual check)
```

Everything that needs a secret key happens **server-side** in `/api/scan`. The
browser never sees your API keys.

---

## 4. Architecture & files

```
flipscan/
  index.html      # the whole phone UI + client logic (no framework, no build)
  api/scan.js     # the serverless function (ESM, Node 18+, zero dependencies)
  package.json    # just declares ESM + Node 18 (no deps to install)
  .env.example    # the environment variables you set in Vercel
  .gitignore      # keeps keys/junk out of git
  README.md       # quick setup / deploy
  DOCS.md         # this file
```

- **No framework, no build step.** `index.html` is plain HTML/CSS/JS; `api/scan.js`
  is a single function. Vercel serves the page statically and runs the function on
  demand. That's deliberate — nothing to maintain, nothing to break on upgrades.
- **Two external services:** Anthropic (required) and eBay (optional).

---

## 5. It works in two stages (graceful degradation)

| You've set… | What you get |
|---|---|
| **Only `ANTHROPIC_API_KEY`** | Full item ID + an **AI resale estimate** + the paid-price verdict + the eBay/Vinted/Depop search links. |
| **+ `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET`** | All of the above, but the price read becomes a **real price band from live eBay listings**, and the verdict judges against that instead of the estimate. |

So it's useful on day one with one key, and gets more accurate when you add eBay.

---

## 6. The frontend (`index.html`) in detail

- **Capture:** one `<input type="file" accept="image/*" multiple>` — on a phone this
  offers **camera or gallery**, and takes **multiple** photos.
- **Client-side resize (`resize()`):** every photo is drawn to a canvas, scaled so
  the longest side is ~1568px, and re-encoded as JPEG q0.82. This keeps uploads
  small (fast, cheap, under Vercel's request-size limit). 1568px (not a smaller size)
  is chosen so small **care-label text stays readable** — fine for whole garments,
  but labels need the extra resolution to read the brand/era.
- **Two modes (shown when 2+ photos are added):**
  - **📸 One item** → all photos sent in **one** request → the AI uses every angle +
    the label together for a richer, single result.
  - **🗂️ Several items** → **one request per photo**, fired in parallel, each rendered
    as its own numbered card as it returns.
- **Rendering (`renderCard()`):** builds the identity header, feature/size/condition
  chips, the 💡 notes line, an authenticity ⚠️ flag if any, the price section, the
  "what you paid" box, and the three search buttons.
- **The verdict (live, no button):** typing in "what you paid" fires on every
  keystroke and compares your cost to the resale number (see §9). No submit button —
  that's intentional; it reacts as you type.
- **Search deep-links:** built from the AI's `search_query`, URL-encoded:
  - eBay → **sold + completed** listings (`LH_Sold=1&LH_Complete=1`) = real ground truth
  - Vinted → `vinted.ie` catalog search
  - Depop → `depop.com` search
  We **deep-link** here on purpose — we never scrape Vinted/Depop (against their
  terms + brittle); you eyeball them in one tap instead.

---

## 7. The backend (`api/scan.js`) in detail

- **`readJson(req)`** — robustly reads the JSON body (handles Vercel's parsed body
  or a raw stream).
- **`identify(images, note)`** — the core. Sends the photo(s) to **Claude Haiku**
  (`claude-haiku-4-5-20251001`, set in the `MODEL` constant) with:
  - **`temperature: 0`** → far more *consistent* reads (not a different guess each
    scan). Note: consistent is not the same as *identical* (vision models still have
    minor non-determinism), and consistent is not the same as *correct*.
  - **Forced tool call:** the model is made to call a `report_item` tool whose
    `input_schema` IS the identity object, so the reply is always valid structured
    JSON — no hand-parsing, no "reply got truncated" failures.
  - A long, structured prompt (the "avoid these mistakes" block, §8) + a strict
    schema (§10).
  - It returns **ONLY JSON**, which `parseModelJson()` extracts (tolerating stray
    code-fences).
- **`getComps(query)`** — optional eBay price lookup:
  - `ebayAuth()` does an OAuth2 **client-credentials** token exchange (cached until
    expiry).
  - Calls the **Browse API** `item_summary/search` for ~50 comparable live listings
    in the chosen marketplace (`EBAY_MARKETPLACE`, default `EBAY_GB`).
  - Computes the **10th / 50th / 90th percentile** prices (`pct()`), returns those +
    4 example listings. Percentiles (not a mean) so a couple of silly outliers don't
    skew it.
  - If no eBay keys are set, returns `null` — the app falls back to the AI estimate.
- **The handler** ties it together: parse images (capped at 5/item) → `identify` →
  `getComps` (wrapped in try/catch so a comps failure never kills the whole scan) →
  returns `{ identity, comps }`.

---

## 8. Recognition guardrails (why it's not easily fooled)

Vintage photos break naive vision models. The prompt explicitly defends against the
8 most common, money-costing mistakes:

1. **Silhouette type-confusion** — folded sleeves read as trouser legs, a flat top as
   a skirt, a 2-piece set as one item. It judges type from collar/cuffs/buttons/hems,
   not the outline.
2. **Brand ≠ printed graphic** — the real brand is on the neck/care label; a Nike
   *print* on a Primark tee is not Nike.
3. **Vintage vs modern repro** — won't call Y2K-*style* fast fashion "vintage" without
   label/stitch/fabric cues.
4. **Size only from the label** — never inferred from the photo; flags possible kids'
   sizing when there's no scale.
5. **Creases/shadows ≠ flaws** — only flags stains/holes/pilling it can actually see.
6. **Material caution** — won't assert silk/leather/wool/real-fur from looks alone.
7. **Ignores** background, hanger, mannequin, hands, reflections.
8. **Says "low confidence"** instead of guessing when genuinely unsure.

More photos (esp. a **label close-up**) beat any prompt — that's what the
multi-upload is for.

---

## 9. The pricing logic (and its honest limits)

**The hierarchy, best to worst:**
1. 🟢 **eBay sold comps** — the truth (what the item *actually sold for*). Wired in
   via the **"💷 Real sold price"** button (SoldComps, `/api/sold`), which pulls real
   sold prices on demand. It's a **button, not automatic**, because the free plan is
   only 100 lookups/month — so you spend one only on items you're seriously weighing.
   When sold data loads, the verdict switches to the sold **median**. (The eBay "sold"
   *link* remains as a free manual check.)
2. 🟡 **eBay active listings** — what the free Browse API returns (**asking** prices,
   which run high because overpriced stock sits unsold). The search is filtered to
   *used + fixed-price + clothing*, dropped to the marketplace currency, and the
   verdict uses a lower **30th-percentile "anchor"** (not the median) to offset the
   asking-price skew. Comps are only trusted when there are **≥8** priced listings
   (`reliable: true`); below that the app falls back to the AI estimate.
3. 🟠 **AI estimate** — Claude's `estimated_resale_eur` range, a **learned prior** from
   training. It's a stable, educated *guess* (not RNG, thanks to temperature 0) — but
   it is **not live data**, has a knowledge cutoff, and should be treated as a
   gut-check, not gospel. Used only when there are no eBay comps.

**The verdict math** (client-side, in `renderCard`):
- `resaleEur` = eBay median (converted to € via a rough FX table) **or** the midpoint
  of the AI estimate.
- `profit = resaleEur − cost`, `multiple = resaleEur / cost`.
- Labels: **🟢 Strong flip** (≥2.5×) · **🟡 Worth it** (≥1.6×) · **🟠 Thin** (≥1.15×) ·
  **🔴 Pass** (<1.15×).
- Shown as **gross** — *before* platform fees and postage. Rule of thumb: a real net
  margin wants ~2×+, which is why 1.6× is only "worth it" and 2.5× is "strong".
- FX is approximate (GBP→EUR ≈ 1.17) and labelled as such.

---

## 10. The data the AI returns (schema)

Every scan returns an `identity` object:

| Field | Meaning |
|---|---|
| `brand` | Maker from the label, or `"unknown"` (not the printed graphic). |
| `item_type` | e.g. "long-sleeve floral top" — includes sleeve length for tops. |
| `era` | "1990s" / "Y2K" / "2000s" / "unknown" / "modern repro?". |
| `key_features` | Colour, pattern, notable details. |
| `size` | Only if readable on the label, else "unknown". |
| `condition_notes` | Visible flaws only. |
| `notes` | One line of resale insight (value drivers / what to check). |
| `search_query` | The concise string used to build the comp search + links. |
| `authenticity_flags` | Fake/bootleg concern, or "none". |
| `confidence` | "high" / "medium" / "low". |
| `estimated_resale_eur` | `{ low, high }` — the AI's rough € resale range. |
| `model_used` | Which model produced the result. |

Plus a `comps` object when eBay keys are set: `{ source, marketplace, query, count,
currency, reliable, low, anchor, median, high, examples[] }` — where `anchor` is the
30th-percentile price the verdict uses and `reliable` is `false` below 8 listings.
On a comps failure it is `{ error: "comps_failed" }`; with no eBay keys it is `null`.

---

## 11. Tech stack, hosting & cost

- **Frontend:** vanilla HTML/CSS/JS. No React, no build.
- **Backend:** one Vercel Serverless Function (Node 18+ runtime, native `fetch`,
  zero npm dependencies).
- **AI:** Anthropic Messages API, Claude Haiku (vision).
- **Comps:** eBay Browse API (OAuth2 client-credentials).
- **Hosting:** Vercel (works equally on Firebase Hosting + one Cloud Function).
- **Env vars:** `FLIPSCAN_SECRET` (required — the shared access code) and
  `ANTHROPIC_API_KEY` (required); `SELL_PLATFORM` (optional, default Vinted);
  `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_MARKETPLACE` (optional).
- **Running cost:** Anthropic ≈ fractions of a cent per photo (Haiku); eBay API free
  tier is plenty; Vercel Hobby tier is free. Effectively free for personal use.

## 12. Privacy & security
- **Keys live only in Vercel's env vars** — never in the page, never in git
  (`.gitignore` covers `.env*`).
- **Photos are resized in the browser** and sent once to the function; they are
  **not stored** anywhere — processed in-memory and discarded.
- The endpoint is protected by a **shared access code** (`FLIPSCAN_SECRET`): the
  client sends it in an `x-flipscan-secret` header and the function rejects anything
  without it with `401` **before** spending any AI credit. (Same-origin / CORS does
  *not* stop a direct POST — the secret does.) Set a monthly spend cap in the
  Anthropic console as a backstop; add Vercel firewall rate-limiting if you want
  belt-and-braces.

---

## 13. How to change things (common tweaks)

- **Swap the AI model:** edit the `MODEL` constant at the top of `api/scan.js`.
- **Change the eBay market/currency:** set `EBAY_MARKETPLACE` (e.g. `EBAY_GB`,
  `EBAY_DE`, `EBAY_US`).
- **Adjust the verdict thresholds:** the `2.5 / 1.6 / 1.15` multiples in
  `renderCard()` in `index.html`.
- **Upgrade to true SOLD comps:** replace the body of `getComps()` with a call to
  eBay's **Marketplace Insights API** (approval-gated) or a sold-comps provider
  (e.g. SoldComps / Soldgraph). Return the same shape (`{source,count,currency,
  low,median,high,examples}`) and nothing else needs to change.
- **Tune recognition:** edit the numbered "avoid these mistakes" block in the prompt.

## 14. Known limitations
- Gives a **comparable range, not an exact match** — every used piece is unique.
- Free eBay data is **asking prices**, not sold (the sold *link*/SoldComps bridge this).
- Image-match comps need the **eBay keys**; without them it falls back to the AI estimate.
- The **sold-price** lookup (SoldComps) is still **keyword**, not image — so it can be
  looser than the image-matched "going for" range above it.
- The AI estimate is a **guess**, not market data — only a fallback.
- Vinted/Depop prices are **manual** (deep links), by design.
- Brand/era accuracy drops without a readable **label** shot.

## 15. Roadmap ideas (not built)
- An optional **"hint" text box** to nudge the AI on ambiguous pieces.
- **Per-item cost entry** carried into a running session total / "flip list".
- **Save scan history** (would need storage).
- **Barcode/label OCR** shortcut for modern branded stock.
- True **sold-comps** provider wired into `getComps()`.

---

## Changelog
- **v0.1** — camera scan → Claude ID → eBay comps → search links.
- **v0.2** — gallery + multi-upload; one-item/several-items modes; 💡 notes field;
  "what you paid" → live buy/pass verdict.
- **v0.3** — hardened recognition (the 8 guardrails); sleeve-length in `item_type`.
- **v0.4** — AI resale estimate so the verdict works before eBay keys; `temperature:0`
  for consistent reads.
- **v0.5** — Security (shared access code, image validation, size caps, note
  sanitisation, no leaked upstream errors). Comps quality (used + fixed-price +
  clothing filter, single currency, min-8 `reliable` gate, 30th-percentile `anchor`,
  query cleaning, broaden-once, closest-to-anchor examples, 5s timeouts). Forced
  tool-call JSON + truncation/timeout handling + estimate validation. Platform-specific
  estimate (`SELL_PLATFORM`). **Net-margin verdict** with editable fee/postage/packaging
  + a €5 profit floor. 1568px resize for readable labels. Low-confidence → label nudge.

- **v0.6** — On-demand real SOLD prices via SoldComps (`/api/sold`, per-button to
  protect the 100/mo free quota); verdict uses the sold median when loaded.
- **v0.7** — Scan/purchase **log** (`/api/log` + `log.html`) on Upstash Redis: tap
  "💾 Log purchase" to save the estimate-at-scan + what you paid; fill in the real
  sold price later; the log page shows totals (spent / sold / net profit) and an
  **estimate-accuracy** readout. This is the passive replacement for a formal test set.
- **v0.8** — **Reverse-image comps.** `getComps()` now calls eBay's
  `search_by_image` (Browse API) with the primary photo FIRST, so the "going for"
  range matches on how the item actually *looks*, not keywords; keyword search is
  the fallback when image match is thin/unavailable. UI labels these "🔍 Visually
  similar". NOTE: the SoldComps "what did it really sell for?" lookup stays
  keyword-based — that provider has no image search. Also a visual redesign
  (Space Grotesk/Inter, depth, glow, logo mark) and plainer human wording throughout.
- **v0.9** — **Web-wide reverse image search** (find the exact item across the net):
  - **"Reverse image search the web"** — an on-demand BUTTON (`api/web.js`) via
    **Google Cloud Vision** web detection (`GOOGLE_VISION_API_KEY`). Returns links to
    the sites hosting that item's image (brand site, boutiques, other marketplaces),
    exact matches first, plus a best-guess name ONLY when it's specific (≥2 words —
    bare category words like "vest" are suppressed). Takes the photo directly, free
    up to ~1,000/month, dormant without a key. On-demand (not per-scan) so a basic
    item never burns a call or clutters the result with a weak label.
  - **"Find it in shops — with prices"** — on-demand button, via **SerpApi Google
    Lens** (`SERPAPI_KEY`, ~100 free/mo). Returns visual matches with **shop name +
    price** inline. Lens needs a public image URL, so `api/lens.js` stashes the photo
    in Upstash (~10-min TTL) and serves it via `api/img.js` for SerpApi to fetch —
    hence it also needs `UPSTASH_*` set. Priced results sorted first.
- **v1.0** — **Comp evidence & confidence** (deep-dive rec #1). Every price now shows
  **how many comps it's based on** and a **confidence badge**: 🟢 green (8+ comps, prices
  within 1.5× the median), 🟡 amber (3–7 comps, or 8+ but prices scattered), 🔴 red
  (<3 comps → "treat as a guess"). Comps drive the number from **3** upward (was 8);
  1–2 comps are still shown as clickable evidence but flagged a guess with the AI
  estimate carrying the price. Up to 6 comps listed, every one a tappable link. The
  SoldComps band shows the same badge. `summarise()` returns `confidence`/`tight`.

_Yan's personal reselling tool — separate from the Let's Get Nessie project it sits next to on disk._
