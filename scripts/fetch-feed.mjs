// Fetches the Instafeed Feed API and writes docs/feed.json in the shape
// Klaviyo's Web Feed / Liquid loop expects. Run by
// .github/workflows/refresh-feed.yml on a schedule; GitHub Pages then
// serves docs/feed.json as a plain public URL for Klaviyo to poll.
//
// Required env vars (see workflow file):
//   INSTAFEED_API_KEY   - secret, from repo Settings > Secrets > Actions
//   INSTAFEED_VERSION   - "v5" (Meta for Business) or "v6" (Instagram Login)
//   INSTAFEED_ACCOUNT   - shop domain, e.g. fillingpieces.myshopify.com
//   INSTAFEED_FEED_ID   - fid, 0 = main feed
//   INSTAFEED_LIMIT     - how many posts to pull, default 9

import { writeFile, mkdir } from "node:fs/promises";

const {
  INSTAFEED_API_KEY,
  INSTAFEED_VERSION = "v5",
  INSTAFEED_ACCOUNT,
  INSTAFEED_FEED_ID = "0",
  INSTAFEED_LIMIT = "9",
} = process.env;

if (!INSTAFEED_API_KEY || !INSTAFEED_ACCOUNT) {
  console.error("Missing INSTAFEED_API_KEY or INSTAFEED_ACCOUNT env vars.");
  process.exit(1);
}

function mapItem(raw) {
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

async function main() {
  const url = new URL(`https://instafeed.nfcube.com/feed/${INSTAFEED_VERSION}`);
  url.searchParams.set("account", INSTAFEED_ACCOUNT);
  url.searchParams.set("limit", INSTAFEED_LIMIT);
  url.searchParams.set("fid", INSTAFEED_FEED_ID);
  url.searchParams.set("fu", "0");

  const res = await fetch(url, {
    headers: { "X-API-Key": INSTAFEED_API_KEY, Accept: "application/json" },
  });
  const json = await res.json();

  const code = json?.meta?.code ?? res.status;
  if (code >= 400) {
    // Leave the previously published feed.json untouched rather than
    // overwriting it with an error — a stale-but-valid feed is better
    // than Klaviyo marking the Web Feed disabled.
    console.error(`Instafeed returned meta.code ${code}: ${json?.meta?.error_message ?? "no message"}`);
    console.error("Leaving existing docs/feed.json in place, not overwriting.");
    process.exit(0);
  }

  const items = Array.isArray(json?.data) ? json.data.map(mapItem) : [];
  await mkdir("docs", { recursive: true });
  await writeFile("docs/feed.json", JSON.stringify({ items }, null, 2) + "\n");
  console.log(`Wrote docs/feed.json with ${items.length} items.`);
}

main().catch((err) => {
  console.error(err);
  // Same reasoning as above: don't let a transient failure wipe out a
  // working feed file. Exit 0 so the workflow doesn't fail loudly on a
  // routine schedule blip; the "no commit" step will simply no-op.
  process.exit(0);
});
