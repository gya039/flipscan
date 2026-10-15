// FlipScan — scan/purchase log, backed by Upstash Redis (REST, no SDK).
// Stores one record per logged purchase in a Redis hash so outcomes (what it
// actually sold for) can be filled in later. Protected by the same access code.
//
// Actions (POST body { action, ... }):
//   save   -> { record }            -> { ok, id }
//   list   -> {}                    -> { records: [...] }
//   update -> { id, patch }         -> { ok }
//   delete -> { id }                -> { ok }

const KEY = "flipscan:scans";

async function readJson(req) {
  if (req.body) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function redis(cmd) {
  const r = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error(`redis ${r.status}: ${await r.text()}`);
  return (await r.json()).result;
}
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
    if (!process.env.FLIPSCAN_SECRET) return res.status(500).json({ error: "server_misconfigured" });
    if ((req.headers["x-flipscan-secret"] || "") !== process.env.FLIPSCAN_SECRET) return res.status(401).json({ error: "unauthorized" });
    if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return res.status(500).json({ error: "log_not_configured" });

    const body = await readJson(req);
    const action = body.action;

    if (action === "save") {
      const rec = { ...(body.record || {}) };
      rec.id = rec.id || newId();
      rec.ts = rec.ts || new Date().toISOString();
      rec.logged_at = rec.logged_at || rec.ts.slice(0, 10);
      await redis(["HSET", KEY, rec.id, JSON.stringify(rec)]);
      return res.status(200).json({ ok: true, id: rec.id });
    }

    if (action === "list") {
      const flat = (await redis(["HGETALL", KEY])) || [];
      const records = [];
      for (let i = 0; i < flat.length; i += 2) {
        try { records.push(JSON.parse(flat[i + 1])); } catch {}
      }
      records.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
      return res.status(200).json({ records });
    }

    if (action === "update") {
      if (!body.id) return res.status(400).json({ error: "no_id" });
      const cur = await redis(["HGET", KEY, body.id]);
      if (!cur) return res.status(404).json({ error: "not_found" });
      const merged = { ...JSON.parse(cur), ...(body.patch || {}) };
      await redis(["HSET", KEY, body.id, JSON.stringify(merged)]);
      return res.status(200).json({ ok: true });
    }

    if (action === "delete") {
      if (!body.id) return res.status(400).json({ error: "no_id" });
      await redis(["HDEL", KEY, body.id]);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "bad_action" });
  } catch (e) {
    console.error("log handler", e);
    return res.status(500).json({ error: "server_error" });
  }
}
