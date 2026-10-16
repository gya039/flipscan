#!/usr/bin/env python3
"""
FlipScan end-to-end test harness — runs against the LIVE site.
Stdlib only (urllib, json, base64, csv). No pip installs.

Usage (run from D:\\Nessie-Assistant\\flipscan):
  set FLIPSCAN_SECRET first (never committed).
  <python> tests/e2e.py                 # dry run: prints the quota plan and stops
  <python> tests/e2e.py --yes           # actually runs (spends the paid calls below)
  flags: --no-sold  --no-vinted  --limit N  --no-log  --base <url>

NOTE ON IMAGE ENCODING: index.html resizes photos to 1568px JPEG q0.82 in a
<canvas> before upload. Python stdlib has no image codec, so this harness sends
the ORIGINAL bytes base64-encoded. Photos over ~2.6MB (MAX_IMG_CHARS) are flagged
"too_large" (the UI would shrink them; we can't without PIL). HEIC is skipped
(the API only accepts jpeg/png/webp; the browser transcodes HEIC, we can't).
"""
import os, sys, io, json, base64, csv, time, ssl, math, argparse, datetime, html, re
import urllib.request, urllib.error

ROOT   = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # .../flipscan
PHOTOS = os.path.join(ROOT, "research", "test-photos")
TRUTH  = os.path.join(PHOTOS, "truth.csv")
OUTBASE= os.path.join(ROOT, "tests", "out")

BASE   = os.environ.get("FLIPSCAN_BASE", "https://flipscan-kappa.vercel.app")
SECRET = os.environ.get("FLIPSCAN_SECRET", "")

MAX_IMG_CHARS = 3_600_000
RATE  = {"GBP": 1.17, "USD": 0.92, "EUR": 1.0, "CAD": 0.68, "AUD": 0.61}
COSTS = {"fee": 0.0, "post": 0.0, "pack": 0.5, "floor": 5.0}   # index.html defaults
MIME  = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}
LENS_WEB_LIMIT = 3     # only first N photos hit SerpApi/Vision (free ~100/mo)
CONF_OK = ("high", "medium", "low")

# ---------------- http ----------------
def post(path, payload, timeout=90):
    url = BASE + path
    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, method="POST",
        headers={"content-type": "application/json", "x-flipscan-secret": SECRET})
    ctx = ssl.create_default_context()
    t0 = time.time()
    status, raw = 0, ""
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            status = getattr(r, "status", 200); raw = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        status = e.code; raw = e.read().decode("utf-8", "replace")
    except Exception as e:
        return {"status": 0, "latency": round(time.time() - t0, 2), "json": {"__transport_error": str(e)}, "raw": ""}
    try:
        j = json.loads(raw)
    except Exception:
        j = {"__unparsed": raw[:400]}
    return {"status": status, "latency": round(time.time() - t0, 2), "json": j, "raw": raw}

# ---------------- helpers ----------------
try:
    from PIL import Image
    try:
        import pillow_heif; pillow_heif.register_heif_opener()
    except Exception:
        pass
    HAVE_PIL = True
except Exception:
    HAVE_PIL = False

def encode_image(path):
    """Resize + encode EXACTLY like index.html: longest side <= 1568px, JPEG quality 0.82."""
    if not HAVE_PIL:
        ext = os.path.splitext(path)[1].lower()
        mime = MIME.get(ext)
        if not mime:
            return None, "no PIL and unsupported ext " + ext
        with open(path, "rb") as f:
            data = "data:%s;base64,%s" % (mime, base64.b64encode(f.read()).decode())
        return data, ("no PIL — sent original; >limit" if len(data) > MAX_IMG_CHARS else "no PIL — sent original bytes")
    try:
        im = Image.open(path)
        im = im.convert("RGB")
    except Exception as e:
        return None, "open_failed: " + str(e)
    w, h = im.size
    m = max(w, h)
    resized = ""
    if m > 1568:
        s = 1568.0 / m
        im = im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)
        resized = "resized %dx%d->%dx%d" % (w, h, im.size[0], im.size[1])
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=82)
    data = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    note = resized
    if len(data) > MAX_IMG_CHARS:
        note = (note + " ; ") + "STILL too large (%d chars)" % len(data)
    return data, note

def query_of(idn):
    sq = (idn.get("search_query") or "").strip()
    if sq:
        return sq
    return " ".join([x for x in [idn.get("brand"), idn.get("item_type"), idn.get("era")] if x]).strip()

def num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)

def eur(v, cur):
    return None if v is None else v * RATE.get(cur or "EUR", 1.0)

def load_truth():
    rows = {}
    if os.path.exists(TRUTH):
        with open(TRUTH, newline="", encoding="utf-8-sig") as f:
            for r in csv.DictReader(f):
                if r.get("file"):
                    rows[r["file"].strip()] = r
    return rows

def save_raw(outdir, name, obj):
    try:
        with open(os.path.join(outdir, "raw", name + ".json"), "w", encoding="utf-8") as f:
            json.dump(obj, f, indent=1, ensure_ascii=False)
    except Exception:
        pass

# ---------------- validation ----------------
def validate_scan(resp):
    checks = []
    def add(name, ok, detail=""): checks.append((name, bool(ok), str(detail)))
    if resp["status"] != 200:
        add("scan_http_200", False, "status %s body %s" % (resp["status"], str(resp["json"])[:140]))
        return checks
    d = resp["json"]; idn = d.get("identity") or {}
    add("brand_present", (idn.get("brand") or "").strip(), idn.get("brand"))
    add("item_type_present", (idn.get("item_type") or "").strip(), idn.get("item_type"))
    add("condition_present", "condition_notes" in idn, idn.get("condition_notes"))
    est = idn.get("estimated_resale_eur") or {}
    lo, hi = est.get("low"), est.get("high")
    add("estimate_lo_le_hi", num(lo) and num(hi) and lo > 0 and hi > 0 and lo <= hi, "%s..%s" % (lo, hi))
    add("confidence_valid", (idn.get("confidence") or "").lower() in CONF_OK, idn.get("confidence"))
    c = d.get("comps")
    if c and not c.get("error") and (c.get("count") or 0) > 0:
        add("comps_shape", all(k in c for k in ("count", "low", "median", "high", "examples")),
            {k: c.get(k) for k in ("count", "low", "median", "high")})
        exs = c.get("examples") or []
        add("examples_url_price", all(e.get("url") and e.get("price") is not None for e in exs) if exs else False,
            "%d examples" % len(exs))
        try:
            add("comps_band_order", c["low"] <= c["median"] <= c["high"], "%s<=%s<=%s" % (c.get("low"), c.get("median"), c.get("high")))
        except Exception:
            add("comps_band_order", False, "non-numeric band")
    else:
        add("comps_optional", True, "no live comps (count 0 / estimate only)")
    leaked = bool(re.search(r"Traceback|/var/task|at Object|ECONNREFUSED|anthropic\.com|sk-ant|apify_api|Bearer ", resp["raw"]))
    add("no_raw_error_leak", not leaked, "LEAKED" if leaked else "clean")
    return checks

def validate_prices(resp, src):
    checks = []; median_eur = None
    def add(name, ok, detail=""): checks.append((name, bool(ok), str(detail)))
    if resp["status"] != 200:
        add("%s_http_200" % src, False, "status %s %s" % (resp["status"], str(resp["json"])[:100])); return checks, None
    d = resp["json"]
    if d.get("error"):
        add("%s_no_error" % src, False, d.get("error")); return checks, None
    cnt = d.get("count") or 0
    if cnt == 0:
        add("%s_empty_ok" % src, True, "count 0 (no comps found)"); return checks, None
    cur = d.get("currency")
    add("%s_currency_known" % src, cur in RATE, cur)
    low, med, anc, high = d.get("low"), d.get("median"), d.get("anchor"), d.get("high")
    mid = med if med is not None else anc
    add("%s_low_le_mid_le_high" % src, num(low) and num(high) and num(mid) and low <= mid <= high, "%s<=%s<=%s" % (low, mid, high))
    exs = d.get("examples") or []
    add("%s_examples_have_url" % src, all(e.get("url") for e in exs) if exs else True, "%d examples" % len(exs))
    median_eur = eur(mid, cur)
    return checks, median_eur

def validate_lensweb(resp, src):
    checks = []
    def add(name, ok, detail=""): checks.append((name, bool(ok), str(detail)))
    if resp["status"] != 200:
        add("%s_http_200" % src, False, "status %s %s" % (resp["status"], str(resp["json"])[:100])); return checks
    d = resp["json"]
    if d.get("error"):
        add("%s_configured" % src, False, d.get("error")); return checks
    if src == "lens":
        add("lens_matches_shape", isinstance(d.get("matches"), list), "%d matches" % len(d.get("matches") or []))
    else:
        add("web_shape", ("pages" in d) or ("best_guess" in d), "pages=%d" % len(d.get("pages") or []))
    return checks

# ---------------- driving source (mirror index.html fixes #1/#3) ----------------
def mid_eur(raw, use="anchor"):
    if not raw or (raw.get("count") or 0) == 0:
        return None
    cur = raw.get("currency", "EUR")
    v = raw.get("median") if use == "median" else (raw.get("anchor") if raw.get("anchor") is not None else raw.get("median"))
    return eur(v, cur)

def compute_driver(comps, sold, vinted, estimate_mid):
    cand = []  # priority order: eBay sold, Vinted, eBay asking
    if sold and (sold.get("count") or 0) >= 5 and mid_eur(sold, "median") is not None:
        cand.append({"key": "eBay sold", "mid": mid_eur(sold, "median"), "count": sold["count"], "min": 5})
    if vinted and (vinted.get("count") or 0) >= 8 and vinted.get("country") == "ie" and mid_eur(vinted) is not None:
        cand.append({"key": "Vinted", "mid": mid_eur(vinted), "count": vinted["count"], "min": 8})
    if comps and (comps.get("count") or 0) >= 8 and mid_eur(comps) is not None:
        cand.append({"key": "eBay asking", "mid": mid_eur(comps), "count": comps["count"], "min": 8})
    if len(cand) >= 2:
        mids = [c["mid"] for c in cand]
        if max(mids) > min(mids) * 2:
            return min(cand, key=lambda c: c["mid"]), True
        return cand[0], False
    if len(cand) == 1:
        return cand[0], False
    return {"key": "AI estimate", "mid": estimate_mid, "count": 0, "min": 0}, False

# ---------------- maths (mirror index.html) ----------------
def max_buy(resale):
    af = resale - resale * COSTS["fee"] / 100.0 - COSTS["post"] - COSTS["pack"]
    return math.floor(min(af / 1.6, af - COSTS["floor"])), af

def verdict(resale, paid):
    af = resale - resale * COSTS["fee"] / 100.0 - COSTS["post"] - COSTS["pack"]
    if not paid:
        return "—", None, None
    net, mult = af - paid, af / paid
    if net < COSTS["floor"]:
        return "Leave it", net, mult
    if mult >= 2.5:
        return "Grab it", net, mult
    if mult >= 1.6:
        return "Worth it", net, mult
    if mult >= 1.15:
        return "A bit tight", net, mult
    return "Leave it", net, mult

# ---------------- log round trip ----------------
def log_roundtrip():
    out, rid = [], None
    def add(n, ok, d=""): out.append((n, bool(ok), str(d)))
    rec = {"brand": "E2E TEST", "item_type": "harness", "price_source": "test", "paid": 1,
           "est_eur": 10, "band_low": 8, "band_high": 12, "bought": True,
           "logged_at": datetime.date.today().isoformat()}
    s = post("/api/log", {"action": "save", "record": rec})
    rid = (s["json"] or {}).get("id") if s["status"] == 200 else None
    add("log_save", s["status"] == 200 and rid, rid or str(s["json"])[:80])
    try:
        if rid:
            l = post("/api/log", {"action": "list"})
            recs = (l["json"] or {}).get("records") or []
            add("log_list_present", any(r.get("id") == rid for r in recs), "%d records" % len(recs))
            u = post("/api/log", {"action": "update", "id": rid, "patch": {"sold_eur": 2}})
            add("log_update", u["status"] == 200 and (u["json"] or {}).get("ok"), str(u["json"])[:60])
            l2 = post("/api/log", {"action": "list"})
            r2 = next((r for r in ((l2["json"] or {}).get("records") or []) if r.get("id") == rid), None)
            add("log_update_applied", r2 and r2.get("sold_eur") == 2, (r2 or {}).get("sold_eur"))
    finally:
        if rid:
            d = post("/api/log", {"action": "delete", "id": rid})
            add("log_delete", d["status"] == 200 and (d["json"] or {}).get("ok"), str(d["json"])[:60])
            l3 = post("/api/log", {"action": "list"})
            gone = not any(r.get("id") == rid for r in ((l3["json"] or {}).get("records") or []))
            add("log_delete_confirmed", gone, "gone" if gone else "STILL PRESENT — CLEAN UP MANUALLY")
    return out

# ---------------- report ----------------
def esc(s): return html.escape(str(s if s is not None else ""))

def write_report(outdir, rows, endpoint_lat, log_results):
    p = os.path.join(outdir, "report.html")
    total = sum(len(r["checks"]) for r in rows) + len(log_results)
    failed = sum(1 for r in rows for (_, ok, _) in r["checks"] if not ok) + sum(1 for (_, ok, _) in log_results if not ok)
    lat_html = "".join("<tr><td>%s</td><td>%d</td><td>%.2fs</td></tr>" % (esc(k), len(v), sum(v) / len(v)) for k, v in endpoint_lat.items() if v)
    log_html = "".join('<li>%s %s <span class="d">%s</span></li>' % ("✓" if ok else "✗", esc(n), esc(d)) for (n, ok, d) in log_results)
    secs = []
    for r in rows:
        chk = "".join('<li class="%s">%s <b>%s</b> <span class="d">%s</span></li>' % ("ok" if ok else "bad", "✓" if ok else "✗", esc(n), esc(d)) for (n, ok, d) in r["checks"])
        thumb = '<img class="th" src="%s">' % r["thumb"] if r.get("thumb") else ""
        shot = '<img class="shot" src="shots/%s.png" onerror="this.style.display=\'none\'">' % esc(r["stem"])
        secs.append("""<section><h3>%s</h3><div class="row">%s<div class="meta">
          <div><b>%s</b> · %s · conf %s</div>
          <div class="d">asking €%s · sold €%s · vinted €%s · MaxBuy €%s · verdict %s</div>
          <div class="d">%s</div></div></div>
          <ul class="checks">%s</ul>%s</section>""" % (
            esc(r["stem"]), thumb, esc(r["brand"]), esc(r["item_type"]), esc(r["confidence"]),
            esc(r["asking_med"]), esc(r["sold_med"]), esc(r["vinted_med"]), esc(r["max_buy"]), esc(r["verdict"]),
            esc(r.get("note") or ""), chk, shot))
    doc = """<!doctype html><meta charset=utf-8><title>FlipScan E2E report</title>
<style>body{font-family:system-ui,sans-serif;background:#0E0F0D;color:#F3F2EC;max-width:900px;margin:0 auto;padding:24px}
h1{font-size:22px}h3{margin:18px 0 6px}.d{color:#A3A69C;font-size:13px}
table{border-collapse:collapse;margin:8px 0}td,th{border:1px solid #2C2F2A;padding:5px 10px;text-align:left;font-size:13px}
.summary{background:#181A17;border:1px solid #2C2F2A;border-radius:12px;padding:14px 18px}
.big{font-size:28px;font-weight:800}.bad{color:#F06A6A}.ok{color:#7EF0A6}
section{border-top:1px solid #2C2F2A;padding-top:12px;margin-top:16px}
.row{display:flex;gap:14px}.th{width:90px;height:90px;object-fit:cover;border-radius:10px}.shot{max-width:100%%;border:1px solid #2C2F2A;border-radius:10px;margin-top:10px}
ul.checks{list-style:none;padding:0;margin:8px 0}ul.checks li{font-size:13px;padding:2px 0}
li.bad b{color:#F06A6A}li.ok b{color:#7EF0A6}</style>
<h1>FlipScan E2E — %s</h1>
<div class="summary"><div class="big %s">%d / %d checks passed</div>
<div class="d">%d failed · base %s · photos %d</div>
<table><tr><th>endpoint</th><th>calls</th><th>avg latency</th></tr>%s</table>
<b>Log round-trip:</b><ul class="checks">%s</ul></div>
%s""" % (datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
         "bad" if failed else "ok", total - failed, total, failed, esc(BASE), len(rows), lat_html, log_html, "".join(secs))
    with open(p, "w", encoding="utf-8") as f:
        f.write(doc)
    return p

# ---------------- main ----------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--yes", action="store_true", help="actually run (spend paid calls)")
    ap.add_argument("--no-sold", action="store_true")
    ap.add_argument("--no-vinted", action="store_true")
    ap.add_argument("--no-log", action="store_true")
    ap.add_argument("--no-twice", action="store_true", help="skip the 2nd scan used for the stable-query check")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--only", default=None, help="only photos whose filename contains this substring")
    ap.add_argument("--base", default=None)
    args = ap.parse_args()
    global BASE
    if args.base:
        BASE = args.base

    if not os.path.isdir(PHOTOS):
        print("No research/test-photos/ directory. Add photos first."); sys.exit(2)
    photos = sorted(f for f in os.listdir(PHOTOS)
                    if os.path.splitext(f)[1].lower() in (".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"))
    if args.only:
        photos = [p for p in photos if args.only.lower() in p.lower()]
    if args.limit > 0:
        photos = photos[:args.limit]
    n = len(photos)
    sold_calls = 0 if args.no_sold else n
    vinted_calls = 0 if args.no_vinted else n
    lens_calls = web_calls = min(LENS_WEB_LIMIT, n)

    print("=" * 56)
    print("FlipScan E2E — target %s" % BASE)
    print("photos: %d  %s" % (n, photos))
    scan_calls = n if args.no_twice else 2 * n
    print("PAID CALLS THIS RUN:")
    print("  /api/scan   : %d  (Anthropic — your AI credit%s)" % (scan_calls, "" if args.no_twice else "; 2x per photo for the stable-query check"))
    print("  /api/sold   : %d  (SoldComps, 100/mo free)" % sold_calls)
    print("  /api/vinted : %d  (Apify, ~EUR0.03 each)" % vinted_calls)
    print("  /api/lens   : %d  (SerpApi, 100/mo free)" % lens_calls)
    print("  /api/web    : %d  (Google Vision, ~1000/mo free)" % web_calls)
    print("  /api/log    : %s  (free; round-trip create+delete, nothing left behind)" % ("skipped" if args.no_log else "6 ops"))
    print("=" * 56)
    if not args.yes:
        print("DRY RUN — nothing sent. Re-run with --yes to spend the calls above.")
        print("Flags: --no-sold  --no-vinted  --limit N  --no-log")
        sys.exit(0)
    if not SECRET:
        print("FLIPSCAN_SECRET not set in env — refusing to run. set it and retry."); sys.exit(2)

    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    outdir = os.path.join(OUTBASE, stamp)
    os.makedirs(os.path.join(outdir, "raw"), exist_ok=True)
    truth = load_truth()
    endpoint_lat = {"scan": [], "sold": [], "vinted": [], "lens": [], "web": []}
    rows = []

    for i, fn in enumerate(photos):
        print("\n[%d/%d] %s" % (i + 1, n, fn))
        stem = os.path.splitext(fn)[0]
        img, imnote = encode_image(os.path.join(PHOTOS, fn))
        row = {"stem": stem, "brand": "", "item_type": "", "confidence": "", "checks": [],
               "asking_med": "—", "sold_med": "—", "vinted_med": "—", "max_buy": "—", "verdict": "—",
               "asking_med_num": None, "sold_med_num": None, "vinted_med_num": None,
               "thumb": img if (img and len(img) < 1_600_000) else "", "note": imnote or ""}
        if not img:
            row["checks"].append(("image_encodable", False, imnote)); rows.append(row); continue

        scan = post("/api/scan", {"images": [img]})
        endpoint_lat["scan"].append(scan["latency"])
        with open(os.path.join(outdir, "raw", stem + ".json"), "w", encoding="utf-8") as f:
            json.dump({"identity": scan["json"].get("identity"), "comps": scan["json"].get("comps"),
                       "__status": scan["status"], "__latency": scan["latency"]}, f, indent=1)
        row["checks"] += validate_scan(scan)
        idn = (scan["json"].get("identity") or {}) if scan["status"] == 200 else {}
        row["brand"], row["item_type"], row["confidence"] = idn.get("brand", ""), idn.get("item_type", ""), idn.get("confidence", "")
        comps = scan["json"].get("comps") if scan["status"] == 200 else None
        q = query_of(idn)

        # fix #4: same photo scanned twice should produce the SAME (deterministic) search_query
        if not args.no_twice:
            scan2 = post("/api/scan", {"images": [img]}); endpoint_lat["scan"].append(scan2["latency"])
            q2 = query_of((scan2["json"].get("identity") or {}) if scan2["status"] == 200 else {})
            row["checks"].append(("stable_search_query", bool(q) and q == q2, "run1 '%s' vs run2 '%s'" % (q, q2)))
            time.sleep(1)

        asking_med = None
        if comps and not comps.get("error") and (comps.get("count") or 0) > 0 and comps.get("median") is not None:
            asking_med = eur(comps["median"], comps.get("currency"))
            resale_anchor = eur(comps.get("anchor"), comps.get("currency"))
        else:
            e = idn.get("estimated_resale_eur") or {}
            resale_anchor = ((e.get("low") or 0) + (e.get("high") or 0)) / 2 or None
        row["asking_med"] = round(asking_med, 1) if asking_med else "—"
        row["asking_med_num"] = asking_med

        if not args.no_sold and q:
            r = post("/api/sold", {"query": q}); endpoint_lat["sold"].append(r["latency"])
            save_raw(outdir, stem + ".sold", {"query": q, "response": r["json"]})
            ch, med = validate_prices(r, "sold"); row["checks"] += ch
            row["sold_med_num"] = med
            if med: row["sold_med"] = round(med, 1)
            row["_sold_raw"] = r["json"]
        if not args.no_vinted and q:
            r = post("/api/vinted", {"query": q}); endpoint_lat["vinted"].append(r["latency"])
            save_raw(outdir, stem + ".vinted", {"query": q, "response": r["json"]})
            ch, med = validate_prices(r, "vinted"); row["checks"] += ch
            row["vinted_med_num"] = med
            if med: row["vinted_med"] = round(med, 1)
            row["_vinted_raw"] = r["json"]
            vj = r["json"]
            print("  VINTED q='%s' count=%s low=%s anchor=%s median=%s high=%s country=%s examples=%s" % (
                q, vj.get("count"), vj.get("low"), vj.get("anchor"), vj.get("median"), vj.get("high"),
                vj.get("country"), [e.get("price") for e in (vj.get("examples") or [])]))
        if i < LENS_WEB_LIMIT:
            r = post("/api/lens", {"image": img}); endpoint_lat["lens"].append(r["latency"]); row["checks"] += validate_lensweb(r, "lens")
            r = post("/api/web", {"image": img}); endpoint_lat["web"].append(r["latency"]); row["checks"] += validate_lensweb(r, "web")

        # driving source + Max Buy + verdict (mirror fixes #1/#3)
        est = idn.get("estimated_resale_eur") or {}
        est_mid = (((est.get("low") or 0) + (est.get("high") or 0)) / 2) or None
        driver, _dis = compute_driver(comps if comps and not comps.get("error") else None, row.get("_sold_raw"), row.get("_vinted_raw"), est_mid)
        row["driver_src"] = driver["key"]
        resale = driver["mid"]
        if resale:
            mb, af = max_buy(resale)
            row["max_buy"] = mb
            absurd = (not math.isfinite(mb)) or (mb > resale)
            row["checks"].append(("max_buy_sane", not absurd, "MaxBuy %s vs driver(%s) €%s" % (mb, driver["key"], round(resale))))
            tr = truth.get(fn) or {}
            paid = float(tr["paid"]) if tr.get("paid") else max(1.0, round(mb * 0.5))
            v, net, mult = verdict(resale, paid)
            row["verdict"] = "%s (paid €%s)" % (v, round(paid))
            row["checks"].append(("verdict_finite", net is not None and math.isfinite(net), "net %s" % net))
            if driver.get("min"):  # fix #1: driver must have at least its minimum comp count
                row["checks"].append(("driver_meets_min", (driver.get("count") or 0) >= driver["min"], "%s count %s >= %s" % (driver["key"], driver.get("count"), driver["min"])))
            tmids = [m for m in [
                mid_eur(row.get("_sold_raw"), "median") if (row.get("_sold_raw") and (row["_sold_raw"].get("count") or 0) >= 5) else None,
                mid_eur(row.get("_vinted_raw")) if (row.get("_vinted_raw") and (row["_vinted_raw"].get("count") or 0) >= 8 and row["_vinted_raw"].get("country") == "ie") else None,
                mid_eur(comps) if (comps and (comps.get("count") or 0) >= 8) else None,
            ] if m]
            if len(tmids) >= 2 and max(tmids) > min(tmids) * 2:  # fix #3: disagreement -> price off the lower
                row["checks"].append(("disagreement_uses_lower", abs(resale - min(tmids)) < 0.6,
                                      "spread %.1fx -> driver EUR%s lowest EUR%.0f" % (max(tmids) / min(tmids), round(resale), min(tmids))))
        else:
            row["checks"].append(("has_a_price", False, "no comps and no estimate"))

        # --- real sanity checks (behaviour, not just shape) ---
        meds = {k: v for k, v in (("asking", row["asking_med_num"]), ("sold", row["sold_med_num"]), ("vinted", row["vinted_med_num"])) if v}
        if len(meds) >= 2:
            mx, mn = max(meds.values()), min(meds.values())
            row["checks"].append(("sources_within_2.5x", mx <= mn * 2.5,
                                  "spread %.1fx %s" % (mx / mn, {k: round(v, 1) for k, v in meds.items()})))
        vc = (row.get("_vinted_raw") or {}).get("count") or 0
        if 0 < vc < 8:
            row["checks"].append(("vinted_not_thin", False, "Vinted count %d (<8) — too thin to trust if it drives Max Buy" % vc))

        # truth comparison
        tr = truth.get(fn)
        if tr:
            if tr.get("brand"):
                row["checks"].append(("truth_brand", tr["brand"].lower() in (idn.get("brand", "").lower()), "truth %s vs %s" % (tr["brand"], idn.get("brand"))))
                row["checks"].append(("brand_not_unknown_vs_truth", idn.get("brand", "").strip().lower() not in ("", "unknown"),
                                      "truth has brand '%s' but AI said '%s'" % (tr["brand"], idn.get("brand"))))
            if tr.get("item_type"):
                row["checks"].append(("truth_item_type", tr["item_type"].lower() in (idn.get("item_type", "").lower()), "truth %s vs %s" % (tr["item_type"], idn.get("item_type"))))
            if tr.get("sold_price"):
                sp = float(tr["sold_price"])
                for src, raw in (("asking", comps), ("sold", row.get("_sold_raw")), ("vinted", row.get("_vinted_raw"))):
                    if raw and (raw.get("count") or 0) > 0 and raw.get("low") is not None:
                        cur = raw.get("currency", "EUR"); lo = eur(raw["low"], cur); hi = eur(raw["high"], cur); md = eur(raw.get("median") or raw.get("anchor"), cur)
                        row["checks"].append(("truth_inband_%s" % src, lo <= sp <= hi, "€%s in €%.0f–%.0f" % (sp, lo, hi)))
                        if md: row["checks"].append(("truth_pcterr_%s" % src, True, "%.0f%% off median €%.0f" % (abs(md - sp) / sp * 100, md)))
        rows.append(row)
        if i < n - 1:
            time.sleep(1)

    # --- run-level sanity: identical medians across DIFFERENT items ---
    for src, key in (("asking", "asking_med_num"), ("sold", "sold_med_num"), ("vinted", "vinted_med_num")):
        seen = {}
        for r in rows:
            v = r.get(key)
            if v:
                seen.setdefault(round(v, 1), []).append(r["stem"])
        for val, stems in seen.items():
            if len(stems) > 1:
                detail = "%s median EUR%s identical across %d items: %s" % (src, val, len(stems), ", ".join(s[:8] for s in stems))
                for r in rows:
                    if r["stem"] in stems:
                        r["checks"].append(("no_dup_median_%s" % src, False, detail))

    # results.csv
    with open(os.path.join(outdir, "results.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["photo", "brand", "item_type", "confidence", "asking_med_eur", "sold_med_eur", "vinted_med_eur",
                    "max_buy_eur", "verdict", "checks_passed", "checks_failed", "failed_list", "note"])
        for r in rows:
            passed = sum(1 for (_, ok, _) in r["checks"] if ok); fail = sum(1 for (_, ok, _) in r["checks"] if not ok)
            failed_list = "; ".join(n for (n, ok, _) in r["checks"] if not ok)
            w.writerow([r["stem"], r["brand"], r["item_type"], r["confidence"], r["asking_med"], r["sold_med"],
                        r["vinted_med"], r["max_buy"], r["verdict"], passed, fail, failed_list, r["note"]])

    log_results = [] if args.no_log else log_roundtrip()
    report = write_report(outdir, rows, endpoint_lat, log_results)

    # console summary
    print("\n" + "=" * 56)
    print("SUMMARY  (base %s)" % BASE)
    total = sum(len(r["checks"]) for r in rows) + len(log_results)
    fail = sum(1 for r in rows for (_, ok, _) in r["checks"] if not ok) + sum(1 for (_, ok, _) in log_results if not ok)
    print("checks: %d passed / %d total" % (total - fail, total))
    for k, v in endpoint_lat.items():
        if v: print("  %-7s avg %.2fs (%d calls)" % (k, sum(v) / len(v), len(v)))
    print("\nFAILURES:")
    anyfail = False
    for r in rows:
        for (nm, ok, d) in r["checks"]:
            if not ok:
                anyfail = True; print("  [%s] %s — %s" % (r["stem"], nm, d))
    for (nm, ok, d) in log_results:
        if not ok:
            anyfail = True; print("  [log] %s — %s" % (nm, d))
    if not anyfail:
        print("  none")
    print("\nout: %s" % outdir)
    print("report: %s" % report)

if __name__ == "__main__":
    main()
