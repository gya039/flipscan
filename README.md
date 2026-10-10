# FlipScan 📷→💶

Snap a vintage item on your phone → Claude IDs it (brand, type, era, flaws, fake-flags)
→ it pulls comparable resale prices and gives you a range + one-tap search links into
eBay (sold), Vinted and Depop.

Built to run on **Vercel** (one static page + one serverless function). Your API keys
live as Vercel env vars — they never touch the browser.

```
flipscan/
  index.html      # the phone UI (camera, resize, results)
  api/scan.js     # serverless fn: photo -> Claude -> eBay comps -> JSON
  package.json    # Node 18+, ESM, zero dependencies
  .env.example    # the env vars to set in Vercel
```

## Works in two stages (so you're never blocked)
- **With just the Anthropic key:** identifies the item + gives tap-through search links. Useful immediately.
- **Add eBay keys:** also shows an automatic price-band (median + low/high + example listings).

## Setup (10 min)

1. **Get an Anthropic API key** — https://console.anthropic.com → *API Keys*. (Required.)
2. *(Optional, for the price-band)* **Get eBay keys** — https://developer.ebay.com → create an app → copy the **Production** *Client ID* and *Client Secret*. Free.
3. **Deploy to Vercel:**
   - Push this `flipscan/` folder to a Git repo and *Import* it in Vercel, **or** run `vercel` in this folder with the CLI.
   - In Vercel → **Settings → Environment Variables**, add the values from `.env.example`:
     `ANTHROPIC_API_KEY` (required), and `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` / `EBAY_MARKETPLACE` (optional).
   - Redeploy. Open the URL on your phone and add it to your home screen.

> Prefer Firebase? Same code works with one Cloud Function (port `api/scan.js`) + Firebase Hosting for `index.html`. Vercel is the least fiddly.

## How it works
- The browser **shrinks the photo to ~1024px** before upload (fast + cheap + under Vercel's body limit).
- `api/scan.js` sends it to **Claude Haiku** (cheap vision; model id in the file — swap if you like), which returns a strict JSON identity incl. a `search_query`.
- If eBay keys are set, it hits the **eBay Browse API** for ~50 comparable listings and returns the 10th/50th/90th-percentile prices + 4 examples.

## Honest limitations (and the upgrade path)
- **Comp *range*, not an exact match** — every used piece is unique. That's the right answer for reselling anyway.
- **v1 uses eBay *active* listings (asking prices), not SOLD.** Still a strong signal, and the **eBay "sold" link** in the UI lets you verify real sold prices in one tap.
  To get true SOLD comps automatically, replace the `getComps()` function in `api/scan.js` with eBay's **Marketplace Insights API** (approval-gated) or a sold-comps provider (e.g. SoldComps / Soldgraph) — nothing else changes.
- **No Vinted/Depop scraping** — those are ToS-grey and brittle; the UI deep-links you into them to eyeball instead.

## Rough running cost
- **Anthropic:** fractions of a cent per photo (Haiku).
- **eBay API:** free tier is plenty for personal use.
- **Vercel:** free Hobby tier is fine.

## Note
This is Yan's personal reselling tool — separate from the Let's Get Nessie project it happens to sit next to on disk.
