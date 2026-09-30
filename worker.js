/**
 * Instafeed -> Klaviyo bridge (Cloudflare Worker)
 * ------------------------------------------------
 * Klaviyo's "Web Feed" fetcher only does a plain GET to a public URL — it
 * cannot send custom headers, so Instafeed's required X-API-Key header can
 * never be attached directly from Klaviyo. This Worker sits in between:
 *
 *   Klaviyo (plain GET, no auth) -> THIS WORKER -> Instafeed Feed API (X-API-Key)
 *
 * It calls Mintt Instafeed's official, documented Feed API server-side
 * (https://docs.minttstudio.com/developer-api/docs/instafeed-api/developer-api),
 * reshapes the response into a small stable JSON contract, and serves it
 * publicly with no auth required — which is exactly what Klaviyo needs to
 * register it as a Web Feed.
 *
 * OUTPUT CONTRACT (what Klaviyo's Liquid loop will see as `feeds.Instafeed.items`):
 * {
 *   "items": [
 *     {
 *       "id": "...",
 *       "type": "image" | "video",
 *       "permalink": "https://instagram.com/p/...",
 *       "username": "handle",
 *       "caption": "...",
 *       "images": {
 *         "thumbnail": "https://...",
 *         "medium_resolution": "https://...",
 *         "full_resolution": "https://..."
 *       }
 *     }
 *   ]
 * }
 *
 * This mirrors the Covet.pics feed shape (item.images.medium_resolution),
 * so the same 3x3-grid Liquid snippet from Klaviyo/Covet.pics docs works
 * unchanged in the email — see klaviyo-grid-snippet.liquid.html.
 * Instafeed's API only returns one image size (standard_resolution), so
 * all three keys above map to the same URL — that's expected, not a bug.
 *
 * ---- SETUP ----
 * Get these 4 values from Shopify Admin -> Apps -> Instafeed -> Channels ->
 * Feed API card (click "API key"):
 *   - API key
 *   - Feed endpoint version: v6 (Instagram Login) or v5 (Meta for Business)
 *   - Your shop domain, e.g. example.myshopify.com
 *   - Feed ID (fid) — 0 for your main feed, or the numeric id of a
 *     secondary feed if you run more than one gallery/channel
 *
 * 1. `npm i -g wrangler` (one-time), then `wrangler login`.
 * 2. In this folder: `wrangler secret put INSTAFEED_API_KEY` (paste the key
 *    when prompted — it is never exposed publicly, only used server-side).
 * 3. Fill in INSTAFEED_VERSION, INSTAFEED_ACCOUNT, INSTAFEED_FEED_ID,
 *    INSTAFEED_LIMIT in wrangler.toml.
 * 4. `wrangler deploy` -> you get a public URL like
 *    https://instafeed-klaviyo-bridge.<your-subdomain>.workers.dev
 * 5. Test it in a browser — you should get back JSON in the OUTPUT CONTRACT
 *    shape above. Use /debug?key=... (see DEBUG_KEY below) to see the RAW
 *    Instafeed response if anything looks off.
 * 6. In Klaviyo: Settings -> Web feeds -> Add Web Feed
 *      Feed name: Instafeed
 *      Feed URL: <the workers.dev URL from step 4>
 *      Request Method: GET
 *      Content Type: JSON
 * 7. In the campaign/flow email editor: Data Feeds button -> enable "Instafeed"
 *    -> paste the Liquid grid snippet from klaviyo-grid-snippet.liquid.html.
 */

const DEBUG_KEY = "changeme-debug-key"; // change this before deploying

function mapInstafeedItemToContract(raw) {
  const imageUrl = raw.images?.standard_resolution?.url ?? "";
  return {
    id: String(raw.id ?? ""),
    type: raw.type ?? "image",
    permalink: raw.link ?? "",
    username: raw.user?.username ?? "",
    caption: raw.caption?.text ?? "",
    tags: raw.tags ?? [],
    images: {
      thumbnail: imageUrl,
      medium_resolution: imageUrl,
      full_resolution: imageUrl,
    },
  };
}

async function fetchInstafeed(env) {
  const base = `https://instafeed.nfcube.com/feed/${env.INSTAFEED_VERSION}`;
  const params = new URLSearchParams({
    account: env.INSTAFEED_ACCOUNT,
    limit: String(env.INSTAFEED_LIMIT || 9),
    fid: String(env.INSTAFEED_FEED_ID || 0),
    fu: "0",
  });

  const upstream = await fetch(`${base}?${params}`, {
    headers: {
      "X-API-Key": env.INSTAFEED_API_KEY,
      Accept: "application/json",
    },
    cf: { cacheTtl: 0 }, // we do our own caching below
  });

  const json = await upstream.json();

  // Instafeed uses a consistent { meta, data } envelope even for non-200
  // logical states (202 building cache, 204 no posts, 401/404/409/503).
  const code = json?.meta?.code ?? upstream.status;
  if (code >= 400) {
    throw new Error(`Instafeed returned meta.code ${code}: ${json?.meta?.error_message ?? "no message"}`);
  }

  // 202 (cache still building) and 204 (no posts yet) are valid, just empty.
  return Array.isArray(json?.data) ? json.data : [];
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Raw passthrough for checking the live Instafeed response.
    if (url.pathname === "/debug") {
      if (url.searchParams.get("key") !== (env.DEBUG_KEY || DEBUG_KEY)) {
        return new Response("Not found", { status: 404 });
      }
      try {
        const items = await fetchInstafeed(env);
        return new Response(JSON.stringify(items, null, 2), {
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        return new Response(`Upstream error: ${err.message}`, { status: 502 });
      }
    }

    const cache = caches.default;
    const cacheKey = new Request(url.origin + "/__feed_cache__", request);
    const ttl = Number(env.CACHE_TTL_SECONDS || 900); // 15 min default

    // Serve from edge cache when fresh — keeps every Klaviyo fetch fast
    // and avoids hammering Instafeed on every campaign send.
    const cached = await cache.match(cacheKey);
    if (cached) {
      return cached;
    }

    let payload;
    try {
      const rawItems = await fetchInstafeed(env);
      payload = { items: rawItems.map(mapInstafeedItemToContract) };
    } catch (err) {
      // Klaviyo disables (and stops sending) any campaign/flow using a feed
      // that errors out. If we have a stale cached copy from KV, prefer
      // serving that over a hard failure.
      const stale = await env.FEED_KV?.get("last_good");
      if (stale) {
        return new Response(stale, {
          headers: { "content-type": "application/json", "x-served-stale": "true" },
        });
      }
      return new Response(JSON.stringify({ items: [] }), {
        status: 200, // still 200 so Klaviyo doesn't mark the feed disabled
        headers: { "content-type": "application/json", "x-upstream-error": err.message },
      });
    }

    const body = JSON.stringify(payload);
    const response = new Response(body, {
      headers: {
        "content-type": "application/json",
        "cache-control": `public, max-age=${ttl}`,
      },
    });

    ctx.waitUntil(cache.put(cacheKey, response.clone(), ttl));
    ctx.waitUntil(env.FEED_KV?.put("last_good", body));

    return response;
  },
};
