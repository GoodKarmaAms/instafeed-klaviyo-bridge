# Instafeed → Klaviyo bridge

## Two ways Instafeed can get into Klaviyo (Mintt Studio confirmed both)

**Option A — native static embed (no code, but not "live")**
Instafeed's own docs describe a direct Klaviyo integration: on the **Pro
plan**, go to Instafeed → Channels → "Get embed code", copy the HTML, paste
it into an HTML block in the Klaviyo campaign editor. No API key, no Web
Feed, no proxy. The catch: it's a snapshot — whatever images were live when
you copied the code are what goes out. To refresh, you re-copy and re-paste
before each send.

**Option B — this bridge (dynamic, refreshes every send)**
Mintt Studio also publishes a real, documented **Feed API**
(https://docs.minttstudio.com/developer-api/docs/instafeed-api/developer-api).
Klaviyo's built-in "Web Feed" feature will fetch any public JSON URL at
send time and expose it in the email editor — but it can only do a plain
GET, no custom headers, and Instafeed's Feed API requires the key as an
`X-API-Key` header. That's the actual reason "the API key can't be
implemented in Klaviyo" directly. This Worker is the missing middle piece:

```
Klaviyo (plain GET, no auth)  →  this Worker  →  Instafeed Feed API (X-API-Key)
```

It calls Instafeed server-side with the key attached, reshapes the
response, caches it, and serves plain public JSON that Klaviyo can register
as a Web Feed — so each send pulls whatever's currently live, automatically.

Pick B if you want it to genuinely auto-update per send with no manual
copy-paste step. Pick A if the Pro plan's static embed is good enough and
you'd rather not run/maintain a Worker.

## Files

- `worker.js` — the Cloudflare Worker (calls the real Instafeed Feed API, reshapes, caches)
- `wrangler.toml` — deploy config (your shop domain, feed id, cache TTL)
- `klaviyo-grid-snippet.liquid.html` — paste-in snippet for the Klaviyo email editor

## Get the 4 values this needs

All from **Shopify Admin → Apps → Instafeed → Channels → Feed API card →
"API key"**:

1. **API key** — for `wrangler secret put INSTAFEED_API_KEY` (below)
2. **Version** — `v6` if Instagram is connected via Instagram Login, `v5`
   if via Meta for Business (the same card tells you which)
3. **Shop domain** — e.g. `filling-pieces.myshopify.com` → `wrangler.toml`
4. **Feed ID (fid)** — `0` for your main feed, or the numeric id of a
   secondary feed if you run more than one gallery → `wrangler.toml`
   (the `44671` from the widget HTML you shared earlier is very likely
   this feed's id — confirm it's the one you want in Channels)

## Deploy (Cloudflare Workers, free tier — no server to manage)

```bash
npm i -g wrangler
wrangler login
cd instafeed-klaviyo-bridge
wrangler secret put INSTAFEED_API_KEY   # paste the key when prompted
wrangler deploy
```

That prints a public URL like
`https://instafeed-klaviyo-bridge.<your-subdomain>.workers.dev`.

Sanity-check it before touching Klaviyo:
`https://<your-worker>.workers.dev/debug?key=<DEBUG_KEY>` returns the raw
Instafeed response — confirm you're seeing real posts back.

## Wire it into Klaviyo

1. Klaviyo → **Settings → Web feeds → Add Web Feed**
   - Feed name: `Instafeed`
   - Feed URL: the `workers.dev` URL from deploy
   - Request Method: `GET`
   - Content Type: `JSON`
   - Save — status should flip to **ok** within a few seconds. If it shows
     **disabled**, check `/debug` first — most likely cause is a wrong
     shop domain, feed id, or version (v5 vs v6).
2. Open the campaign or flow email → **Data Feeds** button at the bottom of
   the editor → enable **Instafeed**.
3. Add a text block → click the `<> Source` button → paste in
   `klaviyo-grid-snippet.liquid.html`.
4. Send yourself a test — web feeds render at send time, so always check a
   live test send before shipping to the full list.

## How "auto-updating" actually works here

- The Worker re-checks Instafeed at most every 15 minutes (`CACHE_TTL_SECONDS`
  in wrangler.toml — lower it if you need fresher data, e.g. `60`).
- Klaviyo re-fetches the Worker's URL **at send time** — for a campaign,
  when it goes out; for a flow, each time a new person reaches that step.
- Once an email has actually landed in someone's inbox, its image grid is
  frozen — new Instagram posts afterward won't retroactively change emails
  already delivered. Each *new* send just picks up whatever's freshest.

## A cheaper alternative worth considering

If neither Instafeed path feels worth the upkeep, **Flowbox** and
**Klaviyo's own native UGC collection** were both built to expose a plain
public feed URL for exactly this use case — no proxy, no field mapping,
nothing to maintain. Worth weighing against "keep Instafeed on the
website, run a small Worker just for email."
