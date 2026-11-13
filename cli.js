#!/usr/bin/env node
// Paid-ad creative breakdown from PeekPanda. Node 18+, no dependencies.
//   GET  /v1/paid-ads?storeIds=...&status=active&format=...&limit=...   pick a rival's live ads (MCP get_ads search)
//   GET  /v1/paid-ads/{platform}/{archiveId}            the stored ad + transcript (MCP get_ads get)
//   GET  /v1/paid-ads/{platform}/{archiveId}/analysis   analysis state + analysis when ready (MCP get_ads analysis)
//   POST /v1/paid-ads/{platform}/{archiveId}/analysis   only with --request (scope content:write, MCP refresh ad_analysis)
// The GET reads return stored state and never start an analysis.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAd, parseApp, toReport, toMarkdown, toCsv, toChat, diff } from './breakdown.js';

const HELP = `Usage:
  PEEKPANDA_TOKEN=... node cli.js --ad meta:111222333 [--ad tiktok:...] [opts]
  PEEKPANDA_TOKEN=... node cli.js --app <storeId|App Store link>[=Label] [--limit 5] [--ad-format video] [opts]
  node cli.js --file breakdown.json [opts]       read a saved run or a saved report

Ads: platform:archiveId, the canonicalKey (paid:meta:111222333) or a Meta ad library link (?id=...).

Options:
  --limit <n>              with --app: live ads to read, 1–40 (default 5; one search call)
  --ad-format <list>       with --app: format filter, e.g. video or video,image (default video)
  --skip-ad-read           do not call GET /v1/paid-ads/{platform}/{archiveId} (saves one call per ad,
                           but then there is no transcript, and --ad mode has no hook or advertiser)
  --request                for ads whose analysis is not_requested or failed, POST an analysis request
                           (needs content:write), then read again every 20 s until ready/failed or --wait
  --wait <seconds>         how long --request waits, 0–300 (default 90; every read counts as a call)
  --state <path>           compare with the report saved at this path, then save this run there
  --archive <dir>          also save the raw responses as <dir>/creative-breakdown-<YYYY-MM-DD>.json
  --format md|csv|json     output format (default md; json is this tool's report)
  --webhook <url>          also POST a short summary to a Slack or Discord incoming webhook
  --tenancy <value>        x-genviral-tenancy header (default personal)
  --api <url>              API base (default https://api.peekpanda.com)

Every call counts toward your plan's daily API and MCP allowance (Peek 30, Panda 1,000, reset 00:00 UTC).`;

function parse(argv) {
  const o = { format: 'md', tenancy: 'personal', api: 'https://api.peekpanda.com', ads: [], apps: [], limit: '5', 'ad-format': 'video', wait: '90' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--request' || a === '--skip-ad-read') o[a.slice(2)] = true;
    else if (a === '--ad' || a === '--app') {
      const v = argv[++i];
      if (v == null) throw new Error(`${a} needs a value.`);
      o[a === '--ad' ? 'ads' : 'apps'].push(...String(v).split(',').map((s) => s.trim()).filter(Boolean));
    } else if (a.startsWith('--')) {
      const v = argv[++i];
      if (v == null) throw new Error(`${a} needs a value. See --help.`);
      o[a.slice(2)] = v;
    } else throw new Error(`Unexpected argument "${a}". See --help.`);
  }
  return o;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0;

async function call(o, path, method = 'GET', retried = false) {
  const token = process.env.PEEKPANDA_TOKEN;
  if (!token) throw new Error('Set PEEKPANDA_TOKEN to a PeekPanda API key (Account → API keys). Never commit it.');
  calls++;
  const res = await fetch(new URL(path, o.api), { method, headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'x-genviral-tenancy': o.tenancy } });
  if (res.ok) return res.json();
  const body = await res.json().catch(() => null);
  const code = body?.error?.code ?? '';
  const retry = Number(res.headers.get('retry-after') ?? body?.error?.retryAfterSeconds);
  // 429 rate_limited: honor a short Retry-After once. daily_call_limit: stop.
  if (code === 'rate_limited' && !retried && retry > 0 && retry <= 70) {
    await sleep(retry * 1000);
    return call(o, path, method, true);
  }
  const hints = {
    daily_call_limit: ' The daily API and MCP allowance is used until 00:00 UTC; stopping.',
    subscription_required: ' This read needs a plan with API access.',
    authorization_required: method === 'POST' ? ' --request needs a credential with the content:write scope.' : ' Check the credential scopes (context:read).',
    workspace_not_accessible: ' The key cannot reach that tenancy; check --tenancy.',
    not_found: ' The ad or app is outside the accessible catalogue.',
  };
  const err = new Error(`PeekPanda API ${res.status} ${code} (${method} ${path.split('?')[0]}): ${String(body?.error?.message ?? res.statusText).replace(/\.$/, '')}.${hints[code] ?? ''}`);
  err.code = code;
  err.status = res.status;
  throw err;
}

async function main() {
  const o = parse(process.argv.slice(2));
  if (o.help) { console.log(HELP); return; }
  if (!['md', 'csv', 'json'].includes(o.format)) throw new Error('--format must be md, csv or json');
  const limit = Number(o.limit), wait = Number(o.wait);
  if (!Number.isInteger(limit) || limit < 1 || limit > 40) throw new Error('--limit must be 1 to 40');
  if (!Number.isFinite(wait) || wait < 0 || wait > 300) throw new Error('--wait must be 0 to 300 seconds');

  let raw = null, input;
  if (o.file) input = JSON.parse(await readFile(o.file, 'utf8'));
  else {
    const fetchedAt = new Date().toISOString();
    const entries = o.ads.map((s) => {
      const p = parseAd(s);
      if (!p) throw new Error(`"${s}" is not platform:archiveId (meta or tiktok), a paid: canonicalKey or a Meta ad library link`);
      return { ...p };
    });
    const apps = o.apps.map((s) => {
      const p = parseApp(s);
      if (!p) throw new Error(`"${s}" is not an App Store id or apps.apple.com link`);
      return p;
    });
    if (!entries.length && !apps.length) throw new Error('Pass --ad, --app or --file. See --help.');
    for (const a of apps) {
      const qs = new URLSearchParams({ storeIds: a.storeId, status: 'active', sort: 'recently_discovered', limit: String(limit) });
      if (o['ad-format'] && o['ad-format'] !== 'all') qs.set('format', o['ad-format']);
      const page = await call(o, `/v1/paid-ads?${qs}`);
      for (const item of page.items ?? []) entries.push({ platform: item.platform, archiveId: item.archiveId, label: a.label, storeId: a.storeId, item });
      if (!(page.items ?? []).length) console.error(`Note: no stored live ${o['ad-format']} ads for ${a.storeId} (not proof there are none anywhere).`);
    }
    const seen = new Set();
    const list = entries.filter((e) => { const k = `${e.platform}:${e.archiveId}`; if (seen.has(k)) return false; seen.add(k); return true; });
    const planned = apps.length + list.length * (o['skip-ad-read'] ? 1 : 2);
    if (planned > 30) console.error(`Note: about ${planned} calls before any --request polling; Peek allows 30 API and MCP calls a UTC day.`);
    for (const e of list) {
      const path = `/v1/paid-ads/${e.platform}/${encodeURIComponent(e.archiveId)}`;
      if (!o['skip-ad-read']) e.ad = await call(o, path);
      e.analysisState = await call(o, `${path}/analysis`);
    }
    if (o.request) {
      const ask = list.filter((e) => ['not_requested', 'failed'].includes(e.analysisState?.status));
      for (const e of ask) {
        try { e.analysisState = await call(o, `/v1/paid-ads/${e.platform}/${encodeURIComponent(e.archiveId)}/analysis`, 'POST'); }
        catch (err) { if (err.code === 'daily_call_limit' || err.code === 'authorization_required') throw err; console.error(`Note: ${e.platform}:${e.archiveId}: ${err.message}`); }
      }
      const until = Date.now() + wait * 1000;
      let pending = list.filter((e) => e.analysisState?.status === 'pending');
      while (pending.length && Date.now() + 20000 <= until) {
        await sleep(20000);
        for (const e of pending) e.analysisState = await call(o, `/v1/paid-ads/${e.platform}/${encodeURIComponent(e.archiveId)}/analysis`);
        pending = pending.filter((e) => e.analysisState?.status === 'pending');
      }
      // A video run also stores the transcript; read the ad again for the ones that just became ready.
      if (!o['skip-ad-read']) for (const e of ask) if (e.analysisState?.status === 'ready' && !e.ad?.transcript) e.ad = await call(o, `/v1/paid-ads/${e.platform}/${encodeURIComponent(e.archiveId)}`);
      if (pending.length) console.error(`Note: ${pending.length} analysis still pending after ${wait}s; run again later (reading again does not start a new run).`);
    }
    raw = { tool: 'paid-ad-creative-breakdown/raw', fetchedAt, source: apps.length ? { apps: apps.map((a) => a.storeId) } : null, ads: list };
    input = raw;
    console.error(`${calls} API call(s) used.`);
  }
  const report = toReport(input);

  let d = null;
  if (o.state) {
    const prev = await readFile(o.state, 'utf8').then(JSON.parse).catch(() => null);
    try { d = diff(report, prev); } catch { console.error(`Note: ${o.state} is not a paid-ad-creative-breakdown report or run, so no comparison was made. It will be replaced.`); }
    await writeFile(o.state, JSON.stringify(report, null, 2));
  }
  if (o.archive) {
    await mkdir(o.archive, { recursive: true });
    const stamp = (report.fetchedAt ?? new Date().toISOString()).slice(0, 10);
    await writeFile(join(o.archive, `creative-breakdown-${stamp}.json`), JSON.stringify(raw ?? input, null, 2));
  }

  if (o.format === 'json') console.log(JSON.stringify(report, null, 2));
  else if (o.format === 'csv') console.log(toCsv(report));
  else console.log(toMarkdown(report, d));

  if (o.webhook) {
    const text = toChat(report, d);
    const isDiscord = /discord(app)?\.com\/api\/webhooks/.test(o.webhook);
    const r = await fetch(o.webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(isDiscord ? { content: text.slice(0, 1900) } : { text }) });
    if (!r.ok) throw new Error(`Webhook returned ${r.status}`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
