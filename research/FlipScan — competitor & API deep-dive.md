# FlipScan — competitor & API deep-dive

Oct 15, 2026 · @Yan

## Bottom line

FlipScan's AI is about as good as theirs, but its pricing data is a step behind. Almost every competitor wraps the same thing: an LLM vision call plus scraped eBay sold listings. The ones that win on trust show the sold comps behind the number.

1. **Sold data is the moat, and nobody gets it officially.** eBay's sold-data API (Marketplace Insights) is limited release, and eBay now pushes signed-out sold searches to a login page. Paid scrapers and resellers of that data fill the gap.
2. **Vinted has no sold data at all.** It has no public API and no sold list, and its Pro API is allowlist-only. Tools that claim "Vinted sold prices" are inferring sales from listings that disappear.
3. **The best competitor runs on Claude, like FlipScan.** Underpriced AI advertises Claude Fable 5 plus an archive of over a million eBay sales. The model isn't the edge; the data and the UX are.
4. **The top complaints are paywalls and accuracy against free tools.** ThriftAI's reviews cluster on forced subscriptions and results that don't beat Google Lens. FlipScan avoids both by being yours and free.
5. **FlipScan's real gap is evidence and outcome tracking, not features.** Add clickable comps, a confidence and comp count, a real sold source, and a log of what you actually sold for. That beats adding crosslisting or social feeds.

## The players

The market is US-centric and eBay-first. Only a handful of tools target Vinted, and none of them targets Ireland. Ratings come from store-tracking sites, so treat them as approximate.

| App | Platform | Price | Rating (reviews) | What it does | Data source (claimed) |
| --- | --- | --- | --- | --- | --- |
| [ThriftAI](https://apppricinglab.com/app/google_play/com.fulcra.thriftai) | iOS, Android | 3-day trial, then a subscription. Sell-through is a paid add-on. | 4.7 (8.2K Play, \~1.1K iOS CA) | Scan, buy/skip, profit, list to eBay | eBay sold listings and sell-through rate |
| [Underpriced AI](https://underpricedai.com/) | Web, iOS, Android, Chrome, MCP | 1 free scan, packs from $0.99, $5/mo for 15 scans | No public store rating found | Scan, clickable sold comps, confidence %, inventory, ROI, publish to eBay/Bonanza | eBay sold, an archive of 1M+ sales, plus Poshmark/Mercari/Depop and category sources |
| [Underpriced.app](https://ca.trustpilot.com/review/underpriced.app) (a different developer) | Web, Chrome | Free tier of 10, then from $2.99/mo | 3.8 Trustpilot | Deal score 0-100, days-to-sell, best platform, negotiation scripts | eBay sold comps |
| [Cluzy](https://underpricedai.com/cluzy-alternative) | iOS, Android | $6.99/wk or $29.99/yr unlimited | Not found | Scan, then list to eBay, plus collections and a discover feed | Not stated |
| [Thrifted](https://apps.apple.com/us/app/id6757867446) | iOS | $4.99/mo or $24.99/yr | 4.3 (20) | Clothing only: value, rarity signal, wardrobe value tracker, shop finder | Not stated |
| [RKFY](https://apps.apple.com/app/id6754532378) | iOS | Subscription | Not found | Vinted/eBay focus (UK), reads the price tag for margin, charity-shop finder | "Vinted and eBay market data" |
| [Vintapp](https://hunted.space/product/vintapp) | iOS (France) | Credits | New | Vinted listing: title, price, AI mannequin photos, auto-fills the Vinted form | Calibrated on 34K Vinted sales |
| [Flip Finder](https://flipfinder.gumroad.com/l/flipfinderbuy) | Chrome extension | £19.99 one-off | n/a | Tags every Vinted listing with its eBay sold price and margin (UK/DE) | eBay sold |
| [Gemli](https://apps.appfollow.io/ios/thrift-profit-finder-gemli/6753282566?country=us) | iOS | Subscription | 3,781 reviews | Scan, visual matches, discover feed | eBay and other sources |
| [Google Lens](https://nifty.ai/post/take-picture-how-much-something-worth) | Free | Free | n/a | Best-in-class identification, no sold prices | Retail and asking prices |

The market is small. One scanner listed for sale on Flippa had about 151 subscribers and about $2.3K MRR ([listing](https://flippa.com/14286659-value-ai-item-price-scanner)).

## How they actually work

Nearly every app runs the same four-step pipeline that FlipScan already runs. They differ only in where the price data comes from and how much of it they show. Most of this is inferred from their own marketing; the inferences are labelled.

1. **Identify.** A vision LLM reads the photo and returns brand, type, era, materials and condition. Underpriced AI names its model, Claude Fable 5 ([source](https://underpricedai.com/)). The rest say "advanced AI", which almost certainly means a GPT, Claude or Gemini vision call (*inferred*). Underpriced AI also takes screenshots of online listings, and RKFY reads the shop's price tag to fill in cost ([source](https://apps.apple.com/app/id6754532378)).
2. **Build a query.** The LLM writes a search string, and good apps broaden it when results are thin. Underpriced AI says it retries with a broader search when an item is described too narrowly ([source](https://underpricedai.com/integrations)).
3. **Price from comps.** This is where they split:
   - *Sold-comps apps* (Underpriced AI, ThriftAI, Underpriced.app) pull eBay sold listings. Underpriced AI chains two paid sold-price services, its own read of eBay sold results, and an archive of over a million recorded sales ([source](https://underpricedai.com/integrations)). It also routes categories to specialist sources such as watch-market or first-edition data ([source](https://underpricedai.com/blog/best-app-to-price-items-for-resale)).
   - *Estimate apps* (most of the long tail) let the LLM guess a range from "market trends", with no comps shown (*inferred* from listings that show no comps).
   - *Vinted tools* use active Vinted listings (V-Hive), eBay sold mapped onto Vinted (Flip Finder), or their own sales dataset (Vintapp, 34K sales).
4. **Decide and act.** Each app gives a deal rating (Great Buy / Good / Fair / Pass, or a 0-100 score), net profit after fees, sometimes days-to-sell or sell-through, then an inventory log and one-tap eBay listing.

**Trust signals that work.** Underpriced AI links every comp to the real eBay listing, shows a confidence colour (green means 80%+ with consistent sold data) ([FAQ](https://underpricedai.com/faq)), and shows the comp count ("14 sold · 30 days"). That is the pattern to copy.

## Data & API landscape

The only free, official source FlipScan can use today is the eBay Browse API, and it returns asking prices only. Sold prices cost either an application process or a paid third-party scraper.

| Source | Gives | Sold or asking | Access | Cost | Notes |
| --- | --- | --- | --- | --- | --- |
| eBay Browse API (FlipScan uses this today) | Active eBay listings | Asking | Free developer key | Free | Runs high compared with sold prices, and auctions skew the low end |
| [eBay Marketplace Insights API](https://developer.ebay.com/api-docs/buy/marketplace-insights/static/overview.html) | eBay sales history, last 90 days, up to 10K items | **Sold** | Limited release: approval by eBay business units, categories whitelisted per partner | Free if approved | Worth applying; expect a no for a solo app |
| [Apify eBay sold actors](https://apify.com/harvestlab/ebay-scraper.md) | Sold price, date, condition, plus p10-p90 band and velocity on some | **Sold** | Apify key | Around $0.005 per sold listing, about $0.10 per scan at 20 comps | eBay now redirects signed-out sold searches to login ([OpenWebNinja](https://www.openwebninja.com/blog/how-to-get-ebay-sold-and-completed-listings)). Some actors say sold still works and [others say it no longer does](https://api.apify.com/v2/actors/qAt5UKgFwKdHZ7NGb/builds/TlpsejpTaSshy56Iy/openapi.json). Test before relying on one. |
| [OpenWebNinja Real-Time eBay Data API](https://www.openwebninja.com/blog/how-to-get-ebay-sold-and-completed-listings) | Sold and completed listings, 20 markets | **Sold** | API key | Not checked | A managed alternative to running a scraper |
| [Apify Vinted scrapers](https://apify.com/sourabhbgp/vinted-scraper.md) | Active Vinted listings: price, brand, size, condition, favourites | Asking | Apify key | About $1-1.50 per 1,000 results, about €0.02 per scan | No sold data exists. "Sold" is inferred when a listing disappears ([source](https://apify.com/webdatalabs/vinted-scraper-pro.md)). Scraping is against Vinted's terms. |
| [Reseller Market Scraper](https://apify.com/brilliant_gum/reseller-market-scraper.md) | Poshmark, Vinted, Mercari, Depop in one run | Both claimed | Apify key | $9 per 1,000 | Its Vinted "sold" figures are an inference too |
| Vinted Pro API | Your own listings | n/a | [Allowlist only](https://apify.com/apium/vinted-scraper) | n/a | Not usable for pricing |
| [SerpApi Google Lens](https://github.com/serpapi/google-lens-scraper) | Visual matches, product names, sometimes prices | Retail / asking | API key | 100 free searches a month ([source](https://termo.ai/skills/image-search)) | A strong identification cross-check. No official Google Lens API exists. |
| Apify Google Lens actors | Same as above | Retail / asking | Apify key | [From about $0.0015 per visual match](https://apify.com/s-r/google-lens) | A cheaper option at volume |

**Fees for the maths.** Vinted charges sellers 0%; the buyer pays about 5% + €0.70 on top ([source](https://www.getonecart.com/how-to-sell-on-vinted/)). FlipScan's platform-fee setting should be 0 for Vinted, and only postage and packaging should come off. Buyers do see the fee on top of your price, which puts mild downward pressure on what you can ask.

Underpriced AI has also shipped an MCP integration, so people can price items from inside Claude or ChatGPT ([source](https://underpricedai.com/integrations)). It's a sign of where the category is heading, but FlipScan doesn't need it.

## What users love and hate

The complaints are about money and trust, not missing features. Users forgive a basic UI if the number is right and they aren't trapped.

**Hate**

- **Paywall before value.** ThriftAI reviewers describe being pushed into a subscription before they can use any core feature ([analysis of 175 reviews](https://marlvel.ai/apps/com-fulcra-thriftai/reviews)). Thrifty's reviews cluster on cancellation trouble and duplicate charges ([source](https://chrome-stats.com/d/id6749215897)).
- **Losing to free tools.** The same ThriftAI reviews say its recognition is inaccurate and slow next to free image search. Resellers keep pointing out that Google Lens plus eBay sold comps still wins ([source](https://nifty.ai/post/take-picture-how-much-something-worth)).
- **Values that run high.** One competitor tested ThriftAI on 29 thrift items against eBay sold prices and found the IDs good but the values high ([source](https://www.underpriced.app/blog/underpriced-vs-thrift-ai-2026)). Treat it as a rival's claim, but it matches the asking-price bias FlipScan already has.
- **Broken links and wrong results** are the top complaint for the "Thrift AI Profit Identifier" clone ([source](https://marlvel.ai/api/llm/apps/shopping/com-thrift-profit-identifier-free)).

**Love**

- **Speed.** Fast, one-hand use at the rack comes up repeatedly as the positive. One guide makes the point that an app taking 30 seconds gets abandoned after the first aisle ([source](https://underpricedai.com/blog/best-thrift-store-apps)).
- **A clear buy/skip.** Beginners value being told what to do and learning which brands matter.
- **Comps they can click.** It's the feature competitors market hardest against each other, which tells you it's what users ask for.

## FlipScan head-to-head

FlipScan already matches the field on the decision (net profit, Max Buy Price, a clear verdict) and beats it on fit for Vinted in Ireland. It trails on evidence: sold data, visible comps, confidence and outcome tracking. The FlipScan column is based on its docs, `scan.js` and the latest changes; flag anything that has moved since.

| Feature | FlipScan | Underpriced AI | ThriftAI | Vinted tools (RKFY, Vintapp, Flip Finder) |
| --- | --- | --- | --- | --- |
| Vision ID | Claude | Claude Fable 5 | Undisclosed | Undisclosed |
| Price source | eBay Browse (asking, EBAY\_GB), plus an on-demand sold lookup | eBay sold, archive, multi-platform | eBay sold | eBay sold, active Vinted, own Vinted dataset |
| Market and currency | Should be Vinted IE / EUR | US eBay-first | US eBay | UK / FR / DE Vinted |
| Comps shown and clickable | Partly (examples) | Yes, every comp links out | Price distribution | Flip Finder tags listings |
| Confidence / comp count | Model confidence only | Confidence % and sold count | Not seen | Not seen |
| Net profit after fees | Yes | Yes | Yes | RKFY margin |
| Max Buy Price | **Yes** | Sourcing calculator | Not seen | No |
| Sell-through / days to sell | No | Weekly price alerts | Paid add-on | No |
| Price-tag reading for cost | No | No | No | **RKFY** |
| Scan log / inventory | Log button | Full inventory, ROI, tax export | Yes | Thrifted wardrobe value |
| Realised ROI / calibration | No | ROI reports | No | No |
| Listing draft | No | AI title and description, publish to eBay | List to eBay | **Vintapp auto-fills Vinted** |
| Paywall | **None** | Credits | Trial, then subscription | Subscription / one-off |

**FlipScan's edges:** no paywall, Max Buy Price at the rack, profit maths built around how you actually sell, and the same model as the market leader.

**FlipScan's gaps, in order of how much they hurt:** asking-price data, comps you can't verify at a glance, no comp count or confidence, and no record of real outcomes to calibrate against.

## Recommendations

Do 1-3 first. Together they cost a few cents a scan and close the trust gap with the best competitor. The rest are cheap wins or can wait.

| # | Change | Why (who does it) | Needs | Cost per scan | Effort |
| --- | --- | --- | --- | --- | --- |
| 1 | Show comp count, spread and a confidence badge. Below about 8 comps, flag the price as a guess. Make every comp a link. | Underpriced AI's core trust signal. It fixes the "looks like an AI guess" problem. | The data you already fetch | €0 | Low |
| 2 | Pull **Vinted active comps** (IE, plus FR/DE as a fallback) and anchor on the 25th-35th percentile. | You sell on Vinted, and none of the competitors price for Vinted Ireland. | Apify Vinted actor | About €0.02 | Medium |
| 3 | Swap eBay asking for **eBay sold** comps; keep Browse as the fallback. | Sold data is the whole category's moat, and asking prices run high. | An Apify sold actor or OpenWebNinja; apply for Marketplace Insights in parallel | About €0.05-0.10 | Medium |
| 4 | Log the outcome on each scan: paid, listed, sold price, days to sell. Show your own hit rate. | Over time it becomes personal sell-through data that nobody else has, the same move as Vintapp's 34K-sale dataset. | A small database (e.g. Firebase, which you already use) | €0 | Medium |
| 5 | Read the shop's price tag from the photo and pre-fill "what you paid". | RKFY does this. It saves a step at the rack. | One extra field in the existing Claude schema | €0 | Low |
| 6 | Add a "copy Vinted listing" button: title, description, brand, size, category, condition. | Vintapp and every listing tool do this. It turns a buy into a listing in seconds. | The existing Claude call | Small | Low |
| 7 | Run Google Lens as a second opinion when confidence is low. | Lens is what pros trust for identification. | SerpApi Lens (100 free a month) | €0 at your volume | Low |
| 8 | Add a days-to-sell estimate from #4's data. | ThriftAI charges extra for this. | #4 running for a while | €0 | Later |

**Don't copy:** subscriptions or paywalls (the top complaint), crosslisting to eBay/Bonanza (out of scope for Vinted selling), discover or social feeds, or "authenticity checks" an LLM can't back up.

**Running cost at 20 scans a day with #2 and #3:** roughly €40-75 a month on data, on top of Claude. Cache results per query for 24 hours to cut that sharply.

## Caveats

No app was installed or paid for. Everything above comes from store listings, developer sites, store-tracking sites (AppFollow, App Pricing Lab, Marlvel) and API docs.

- Much of the comparison content is written by Underpriced AI and Underpriced.app about their rivals. It's used here for facts (prices, features) and treated as biased on accuracy.
- Data prices are list prices from Apify and SerpApi pages, current as of the date above. Test any scraper on 10 real items before wiring it in, because sources disagree on whether eBay sold scraping still works without a login.
- Scraping Vinted breaches its terms. Low-volume personal use is a judgement call for you to make; don't build a public product on it.
- Reddit was not reachable for direct quotes, so independent user opinion comes from review aggregators and the one Reddit comment quoted by Nifty.
