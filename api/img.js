// FlipScan — short-lived public image server, backed by Upstash Redis.
// Only purpose: give SerpApi (Google Lens) a public URL to fetch the scanned photo.
// lens.js stashes the image under a random id with a ~10-min TTL; this returns it.
// No access code on purpose — SerpApi fetches it anonymously. The id is random and
// the key auto-expires, so nothing sensitive lingers.

async function redis(cmd) {
  const r = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error(`redis ${r.status}`);
  return (await r.json()).result;
}

export default async function handler(req, res) {
  try {
    const id = String(req.query.id || "").replace(/[^a-z0-9]/gi, "").slice(0, 40);
    if (!id) return res.status(400).end();
    if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return res.status(500).end();

    let v;
    try { v = await redis(["GET", "flipscan:img:" + id]); } catch { return res.status(502).end(); }
    if (!v) return res.status(404).end();

    let obj;
    try { obj = JSON.parse(v); } catch { return res.status(500).end(); }
    const buf = Buffer.from(obj.b || "", "base64");
    res.setHeader("content-type", obj.m || "image/jpeg");
    res.setHeader("cache-control", "public, max-age=600");
    return res.status(200).send(buf);
  } catch (e) {
    console.error("img handler", e);
    return res.status(500).end();
  }
}
