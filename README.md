# paid-ad-creative-breakdown

What is inside your rival's Meta or TikTok ad, second by second? This tool reads PeekPanda's stored creative analysis of each ad and turns it into a short breakdown you can hand to whoever makes your ads: a one-line summary, hook notes, the scene timeline, on-screen text, the moment the product first appears, the transcript and the "reusable ingredients" the analysis names. Across several ads it shows what they share: median length, cuts, when the product shows up, pace, and which ingredients repeat. With `--state` it lists what changed since the last run, for example a new live ad or an analysis that just became ready.

Output is Markdown, CSV or JSON, and it can post a short summary to Slack or Discord. Node 18+, no dependencies. There is also a [browser version](https://fdarkaou.github.io/paid-ad-creative-breakdown/) that reads pasted JSON and never sends anything anywhere.

```
## Paid-ad creative breakdown

3 ad(s): 2 analysis ready, 0 pending, 0 failed, 1 not requested. 2 transcript(s). Read 2026-11-13.

Across 2 video timeline(s): median length 20.5s, median 5 cut(s), product shown at median 3s (in the first 3 s in 1 of 2).
Pace: fast 1, medium 1. Format: creator pov 1, product demo 1.

### Reusable ingredients (ads that use each)

- product demonstration: 2
- outcome shown first: 1
- pov caption: 1
- screen recording: 1
- utility-first hook: 1

### Since the last report

- new in this read: Example Meals meta:900000000000003 “7 dinners, 1 shopping list” (analysis not_requested)
- Example Meals tiktok:7400000000000000002: analysis pending → ready
- not in this read: Example Meals meta:900000000000000
- new ingredients: outcome shown first, pov caption, screen recording

### Ads

| Ad | Advertiser | Format | Hook | CTA | Days live | Analysis | Length | Product at | Cuts |
|---|---|---|---|---|---|---|---|---|---|
| meta:900000000000001 | Example Meal Planner | video | “Turn saved recipes into a grocery list” | Install now | 72 | ready | 17s | 0s | 3 |
| tiktok:7400000000000000002 | Example Meal Planner | video | “POV: dinner is planned before you leave work” | Download | 24 | ready | 24s | 6s | 7 |
| meta:900000000000003 | Example Meal Planner | image | “7 dinners, 1 shopping list” | Learn more | 5 | not_requested | — | — | — |

...
```

(Example data from `examples/`, not real apps or ads.)

## Run it

```sh
export PEEKPANDA_TOKEN=...   # PeekPanda API key; never commit it

# The 5 newest live video ads of one rival app (1 search call + 2 calls per ad)
node cli.js --app https://apps.apple.com/us/app/example/id1000000001=Rival

# Ads you already know: platform:archiveId, the canonicalKey or a Meta ad library link
node cli.js --ad meta:111222333 --ad paid:tiktok:7400000000000000002

# Ask for missing analyses (needs scope content:write), wait up to 90 s, keep a weekly diff
node cli.js --app 1000000001 --request --state state.json --archive history

# Re-render a saved run or report without calling the API
node cli.js --file examples/breakdown.json --format csv
```

`node cli.js --help` lists every option. `node --test test/` runs the tests. `.github/workflows/creative-breakdown.yml` is a weekly GitHub Actions example. It is off until you set the repository variable `ENABLE_CREATIVE_BREAKDOWN=true`, and it only reads stored analyses.

## Where the data comes from

The data comes from [PeekPanda](https://peekpanda.com), an iOS competitor catalogue where every app has a case file of dated, stored evidence. The tool calls:

- [`GET /v1/paid-ads`](https://peekpanda.com/docs/search-paid-ads) with `storeIds={storeId}&status=active&sort=recently_discovered&format=video&limit={n}` (MCP `get_ads`, action `search`), once per `--app`. `storeIds` returns only ads verified to link to that app. `--ad-format all` drops the format filter.
- [`GET /v1/paid-ads/{platform}/{archiveId}`](https://peekpanda.com/docs/get-paid-ad) (MCP `get_ads`, action `get`), once per ad: the stored observation (`item`: advertiser, status, start date, creative hook/body/CTA/format, destination, ad library link) plus `transcript` and `analysis`, which are null until collected. `--skip-ad-read` leaves this call out.
- [`GET /v1/paid-ads/{platform}/{archiveId}/analysis`](https://peekpanda.com/docs/get-paid-ad-analysis) (MCP `get_ads`, action `analysis`), once per ad. `status` is `not_requested`, `pending`, `ready` (with `analysis`) or `failed` (with `failedAt`). This read never starts an analysis.
- Only with `--request`: [`POST /v1/paid-ads/{platform}/{archiveId}/analysis`](https://peekpanda.com/docs/analyze-paid-ad-creative) (MCP `refresh`, action `ad_analysis`, scope `content:write`) for ads whose status is `not_requested` or `failed`. It answers at once with `pending`; a background worker runs it, usually within a minute. The tool then reads the state every 20 seconds until it is ready or failed, or until `--wait` runs out. For a video, the same run also stores the transcript when it is missing, so the tool reads the ad once more for ads that became ready.

All reads use scope `context:read`. Each call counts toward your plan's daily API and MCP allowance: 30 a day on Peek, 1,000 a day on Panda, reset at 00:00 UTC ([plans](https://peekpanda.com/docs/plans-and-refreshes)). The tool prints how many calls it used, warns when a run plans more than 30, retries once on `429 rate_limited` with a short `Retry-After`, and stops on `daily_call_limit`.

How it reads the analysis (field names as in the docs):

- `summary`, `hookNotes`, `visibleText`, `timestampNotes`, `editingPattern`, `reusablePromptIngredients`, `model` and `generatedAt` are shown as returned.
- `timeline` (only when the analysis has one; the docs say a video analysis stored before timelines is regenerated to add one): `durationSeconds`, `format`, `pace`, `cutCount`, `productAppearsAtSeconds`, `scenes` and `onScreenText`, each with `startSeconds` and `endSeconds`. On-screen text comes from the timeline when there is one, else from `visibleText`.
- Ingredients are counted once per ad, ignoring case. Medians only use ads with a timeline. "Product in the first 3 s" counts ads with `productAppearsAtSeconds` ≤ 3.
- The analysis state read decides the status. If you pass a bare ad read without a state, a non-null `analysis` on it counts as ready.
- Transcript: `text` and `language` as returned; the word count is counted from `text`.
- Days live are whole UTC days from the start day to the day of the read, for live ads with a start date.

What it does not say: the analysis is a creative observation of the stored public ad, not a performance or policy claim, and there is no spend or reach here (`performance.kind` is `unavailable` unless the public record reports it). An ad with no analysis has simply not been analysed. Zero stored ads is not proof of none anywhere. Image and video links are short-lived, so the tool leaves them out.

## Use it from an AI agent (MCP)

The PeekPanda MCP server at `https://mcp.peekpanda.com/mcp` exposes the same reads: `get_ads` with actions `search`, `get` and `analysis`, and `refresh` with action `ad_analysis`. Clients sign in with OAuth (the server's OAuth metadata lists PKCE `S256` and dynamic client registration) and ask for scopes `context:read` and `content:write`; clients that cannot do OAuth send an API key as a bearer token on the same URL. Either way you need a PeekPanda account, and the tokens stay in your client, never in this repo. An agent can call `get_ads` with `{"action": "analysis", "params": {"platform": "meta", "archiveId": "111222333"}}` and then feed the saved responses to `node cli.js --file`.

## Licence

MIT. Example data in `examples/` is made up.
