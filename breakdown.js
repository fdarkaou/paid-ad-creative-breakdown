// paid-ad-creative-breakdown: turn PeekPanda's stored creative analysis of rival Meta and TikTok ads
// into a short breakdown: hook notes, scene timeline, on-screen text, transcript and reusable ingredients.
// Pure functions, no dependencies. Works in Node 18+ and in the browser.
export const TOOL = 'paid-ad-creative-breakdown';
export const STATUSES = ['ready', 'pending', 'failed', 'not_requested'];

const str = (x) => (typeof x === 'string' && x.trim() ? x.trim() : null);
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const arr = (x) => (Array.isArray(x) ? x : []);
const strs = (x) => arr(x).map(str).filter(Boolean);
const DAY = 86400000;

export function median(xs) {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// "meta:123", "tiktok:456", "paid:meta:123" (canonicalKey) or a Meta ad library link (?id=123).
export function parseAd(s) {
  const t = String(s ?? '').trim();
  let m = t.match(/^(?:paid:)?(meta|tiktok):([^\s:/?#]{1,255})$/i);
  if (m) return { platform: m[1].toLowerCase(), archiveId: m[2] };
  m = t.match(/^https:\/\/(?:www\.)?facebook\.com\/ads\/library\/?\?(?:.*&)?id=(\d{1,255})/i);
  if (m) return { platform: 'meta', archiveId: m[1] };
  return null;
}

export function parseApp(s) {
  const t = String(s ?? '').trim();
  const [id, label] = t.split('=');
  const m = id.match(/^(?:id)?(\d{5,12})$/) ?? id.match(/apps\.apple\.com\/.*\/id(\d{5,12})/);
  return m ? { storeId: m[1], label: str(label) } : null;
}

function itemOf(item, readAt) {
  if (!item || typeof item !== 'object') return {};
  const c = item.creative ?? {};
  const started = str(item.startedAt);
  const live = item.status === 'active' && started && readAt;
  return {
    advertiser: str(item.advertiser?.name),
    status: str(item.status),
    format: str(c.format),
    hook: str(c.hook) ?? str(c.title),
    body: str(c.body),
    cta: str(c.ctaText),
    startedAt: started,
    endedAt: str(item.endedAt),
    discoveredAt: str(item.discoveredAt),
    daysLive: live ? Math.max(0, Math.floor((Date.parse(readAt.slice(0, 10)) - Date.parse(started.slice(0, 10))) / DAY)) : null,
    destinationKind: str(item.destination?.kind),
    destinationHost: str(item.destination?.host),
    sourceUrl: str(item.sourceUrl),
  };
}

function analysisOf(a) {
  if (!a || typeof a !== 'object') return null;
  const t = a.timeline && typeof a.timeline === 'object' ? a.timeline : null;
  const span = (x) => ({ startSeconds: num(x?.startSeconds), endSeconds: num(x?.endSeconds) });
  return {
    summary: str(a.summary),
    visibleText: strs(a.visibleText),
    hookNotes: strs(a.hookNotes),
    timestampNotes: arr(a.timestampNotes).map((x) => ({ timestampSeconds: num(x?.timestampSeconds), note: str(x?.note) })).filter((x) => x.note),
    timeline: t && {
      durationSeconds: num(t.durationSeconds),
      format: str(t.format),
      pace: str(t.pace),
      cutCount: num(t.cutCount),
      productAppearsAtSeconds: num(t.productAppearsAtSeconds),
      scenes: arr(t.scenes).map((x) => ({ ...span(x), description: str(x?.description) })).filter((x) => x.description),
      onScreenText: arr(t.onScreenText).map((x) => ({ ...span(x), text: str(x?.text) })).filter((x) => x.text),
    },
    editingPattern: str(a.editingPattern),
    ingredients: strs(a.reusablePromptIngredients),
    model: str(a.model),
    generatedAt: str(a.generatedAt),
  };
}

function transcriptOf(t) {
  const text = str(t?.text);
  if (!text) return null;
  return { text, language: str(t.language), words: text.split(/\s+/).length, generatedAt: str(t.generatedAt) };
}

const isReport = (x) => x && x.tool === TOOL && Array.isArray(x.ads);
const looksRaw = (e) => e && typeof e === 'object' && ('analysisState' in e || 'ad' in e || 'item' in e);

// One raw entry as the CLI saves it:
// { platform, archiveId, label?, item?, ad?: GET /v1/paid-ads/{p}/{id} response, analysisState?: GET .../analysis response }
// A bare GET /v1/paid-ads/{platform}/{archiveId} response ({ item, transcript, analysis, ... }) works too.
const isAdRead = (e) => e && e.item && !e.ad && ('transcript' in e || 'analysis' in e || 'sameAppAds' in e);
function adOf(e0, readAt) {
  const e = isAdRead(e0) ? { ad: e0 } : e0;
  const item = e.ad?.item ?? e.item ?? null;
  const platform = str(e.platform) ?? str(item?.platform);
  const archiveId = str(e.archiveId) ?? str(item?.archiveId);
  const state = e.analysisState ?? null;
  // The analysis read is the source of status. Without it, a stored analysis on the ad read counts as ready.
  const rawAnalysis = state?.status === 'ready' ? state.analysis : (state ? null : e.ad?.analysis ?? null);
  const status = str(state?.status) ?? (rawAnalysis ? 'ready' : null);
  const analysis = analysisOf(rawAnalysis);
  return {
    key: platform && archiveId ? `${platform}:${archiveId}` : null,
    platform,
    archiveId,
    label: str(e.label),
    ...itemOf(item, readAt),
    analysisStatus: status,
    requestedAt: str(state?.requestedAt),
    failedAt: str(state?.failedAt),
    analysis,
    transcript: transcriptOf(e.ad?.transcript),
  };
}

function tally(list) {
  const m = new Map();
  for (const k of list) if (k) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key, count]) => ({ key, count }));
}

export function toReport(input, { fetchedAt = null } = {}) {
  if (isReport(input)) return input;
  const bundle = Array.isArray(input) ? { ads: input } : isAdRead(input) ? { ads: [input] } : input;
  const list = arr(bundle?.ads);
  if (!list.length || !list.every(looksRaw)) {
    throw new Error('Expected a GET /v1/paid-ads/{platform}/{archiveId} response (or an array of them), the JSON the CLI saves ({ ads: [{ platform, archiveId, ad, analysisState }] }) or its report. See examples/.');
  }
  const readAt = fetchedAt ?? str(bundle.fetchedAt);
  const ads = list.map((e) => adOf(e, readAt));
  const ready = ads.filter((a) => a.analysis);
  const tl = ready.map((a) => a.analysis.timeline).filter(Boolean);
  const appear = tl.map((t) => t.productAppearsAtSeconds).filter((x) => x != null);
  return {
    tool: TOOL,
    fetchedAt: readAt,
    source: bundle.source ?? null,
    ads,
    totals: {
      ads: ads.length,
      byStatus: Object.fromEntries(STATUSES.map((s) => [s, ads.filter((a) => a.analysisStatus === s).length])),
      withTimeline: tl.length,
      withTranscript: ads.filter((a) => a.transcript).length,
      medianDurationSeconds: median(tl.map((t) => t.durationSeconds)),
      medianCutCount: median(tl.map((t) => t.cutCount)),
      medianProductAppearsAtSeconds: median(appear),
      productInFirst3s: appear.length ? appear.filter((x) => x <= 3).length : null,
      productAppearsKnown: appear.length,
    },
    ingredients: tally(ready.flatMap((a) => [...new Set(a.analysis.ingredients.map((x) => x.toLowerCase()))])),
    timelineFormats: tally(tl.map((t) => t.format)),
    paces: tally(tl.map((t) => t.pace)),
    adFormats: tally(ads.map((a) => a.format)),
  };
}

const name = (a) => a.label ?? a.advertiser ?? a.key ?? 'ad';
const q = (s, n = 70) => (s ? `“${s.length > n ? s.slice(0, n - 1) + '…' : s}”` : '—');
export const fmt = (x, unit = '') => (x == null ? '—' : `${Math.round(x * 10) / 10}${unit}`);
const sec = (x) => (x == null ? '?' : `${fmt(x)}s`);

export function diff(cur, prev) {
  if (!prev) return null;
  const p = toReport(prev);
  const before = new Map(p.ads.map((a) => [a.key, a]));
  const now = new Map(cur.ads.map((a) => [a.key, a]));
  const out = { newAds: [], gone: [], statusChanges: [], stopped: [], newIngredients: [] };
  for (const a of cur.ads) {
    const b = before.get(a.key);
    if (!b) { out.newAds.push(a); continue; }
    if (b.analysisStatus !== a.analysisStatus) out.statusChanges.push({ ad: a, from: b.analysisStatus, to: a.analysisStatus });
    if (b.status === 'active' && a.status && a.status !== 'active') out.stopped.push({ ad: a, to: a.status });
  }
  for (const b of p.ads) if (!now.has(b.key)) out.gone.push(b);
  const old = new Set(p.ingredients.map((x) => x.key));
  out.newIngredients = cur.ingredients.filter((x) => !old.has(x.key)).map((x) => x.key);
  return out;
}

export function diffLines(d) {
  if (!d) return [];
  const l = [];
  for (const a of d.newAds) l.push(`new in this read: ${name(a)} ${a.key} ${q(a.hook, 50)} (analysis ${a.analysisStatus ?? 'unknown'})`);
  for (const x of d.statusChanges) l.push(`${name(x.ad)} ${x.ad.key}: analysis ${x.from ?? 'unknown'} → ${x.to ?? 'unknown'}`);
  for (const x of d.stopped) l.push(`${name(x.ad)} ${x.ad.key}: ad status active → ${x.to}`);
  for (const a of d.gone) l.push(`not in this read: ${name(a)} ${a.key}`);
  if (d.newIngredients.length) l.push(`new ingredients: ${d.newIngredients.join(', ')}`);
  return l;
}

export function toMarkdown(r, d = null) {
  const t = r.totals;
  const L = ['## Paid-ad creative breakdown', ''];
  L.push(`${t.ads} ad(s): ${t.byStatus.ready} analysis ready, ${t.byStatus.pending} pending, ${t.byStatus.failed} failed, ${t.byStatus.not_requested} not requested. ${t.withTranscript} transcript(s). Read ${r.fetchedAt ? r.fetchedAt.slice(0, 10) : 'from file'}.`);
  if (t.withTimeline) {
    L.push('', `Across ${t.withTimeline} video timeline(s): median length ${sec(t.medianDurationSeconds)}, median ${fmt(t.medianCutCount)} cut(s), product shown at median ${sec(t.medianProductAppearsAtSeconds)}${t.productAppearsKnown ? ` (in the first 3 s in ${t.productInFirst3s} of ${t.productAppearsKnown})` : ''}.`);
    if (r.paces.length) L.push(`Pace: ${r.paces.map((x) => `${x.key} ${x.count}`).join(', ')}. Format: ${r.timelineFormats.map((x) => `${x.key} ${x.count}`).join(', ') || '—'}.`);
  }
  if (r.ingredients.length) {
    L.push('', '### Reusable ingredients (ads that use each)', '');
    for (const x of r.ingredients) L.push(`- ${x.key}: ${x.count}`);
  }
  const dl = diffLines(d);
  if (d) L.push('', '### Since the last report', '', ...(dl.length ? dl.map((x) => `- ${x}`) : ['- No changes.']));
  L.push('', '### Ads', '', '| Ad | Advertiser | Format | Hook | CTA | Days live | Analysis | Length | Product at | Cuts |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const a of r.ads) {
    const tl = a.analysis?.timeline;
    L.push(`| ${a.key ?? '—'} | ${a.advertiser ?? a.label ?? '—'} | ${a.format ?? '—'} | ${q(a.hook, 45).replace(/\|/g, '/')} | ${a.cta ?? '—'} | ${fmt(a.daysLive)} | ${a.analysisStatus ?? '—'} | ${tl ? sec(tl.durationSeconds) : '—'} | ${tl ? sec(tl.productAppearsAtSeconds) : '—'} | ${tl ? fmt(tl.cutCount) : '—'} |`);
  }
  for (const a of r.ads) {
    L.push('', `### ${name(a)} · ${a.key ?? ''}`, '');
    if (a.sourceUrl) L.push(`Ad library: ${a.sourceUrl}`, '');
    if (!a.analysis) {
      const why = { pending: `analysis is running (asked ${a.requestedAt?.slice(0, 16) ?? '?'}); read again in a minute`, failed: `last analysis run produced nothing (${a.failedAt?.slice(0, 10) ?? '?'}); ask again with --request`, not_requested: 'nobody has asked for an analysis yet; pass --request to ask (content:write)' };
      L.push(`No analysis: ${why[a.analysisStatus] ?? 'analysis state not read'}.`);
    } else {
      const an = a.analysis;
      if (an.summary) L.push(`**Summary:** ${an.summary}`, '');
      if (an.editingPattern) L.push(`**Editing:** ${an.editingPattern}`);
      if (an.hookNotes.length) L.push('', '**Hook notes:**', ...an.hookNotes.map((x) => `- ${x}`));
      const tl = an.timeline;
      if (tl?.scenes.length) L.push('', `**Scenes** (${tl.format ?? '?'}, ${tl.pace ?? '?'} pace):`, ...tl.scenes.map((s) => `- ${sec(s.startSeconds)}–${sec(s.endSeconds)}: ${s.description}`));
      if (tl?.onScreenText.length) L.push('', '**On-screen text:**', ...tl.onScreenText.map((s) => `- ${sec(s.startSeconds)}–${sec(s.endSeconds)}: ${q(s.text, 120)}`));
      else if (an.visibleText.length) L.push('', '**Visible text:**', ...an.visibleText.map((s) => `- ${q(s, 120)}`));
      if (an.timestampNotes.length) L.push('', '**Moments:**', ...an.timestampNotes.map((s) => `- ${sec(s.timestampSeconds)}: ${s.note}`));
      if (an.ingredients.length) L.push('', `**Ingredients:** ${an.ingredients.join(' · ')}`);
      L.push('', `_Analysis by ${an.model ?? '?'} at ${an.generatedAt?.slice(0, 10) ?? '?'}._`);
    }
    if (a.transcript) L.push('', `**Transcript** (${a.transcript.language ?? '?'}, ${a.transcript.words} words): ${q(a.transcript.text, 400)}`);
  }
  L.push('', '_Creative observations from stored public ad-library records, not performance. No spend or reach here._');
  return L.join('\n');
}

const csvCell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
export function toCsv(r) {
  const cols = ['key', 'platform', 'archive_id', 'advertiser', 'status', 'format', 'hook', 'cta', 'started_at', 'days_live', 'destination', 'analysis_status', 'summary', 'duration_s', 'pace', 'cut_count', 'product_appears_s', 'scenes', 'ingredients', 'transcript_words', 'analysis_generated_at', 'ad_library_url'];
  const rows = r.ads.map((a) => {
    const an = a.analysis, tl = an?.timeline;
    return [a.key, a.platform, a.archiveId, a.advertiser, a.status, a.format, a.hook, a.cta, a.startedAt, a.daysLive, a.destinationHost ?? a.destinationKind, a.analysisStatus, an?.summary, tl?.durationSeconds, tl?.pace, tl?.cutCount, tl?.productAppearsAtSeconds, tl?.scenes.length, an?.ingredients.join('; '), a.transcript?.words, an?.generatedAt, a.sourceUrl];
  });
  return [cols, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
}

export function toChat(r, d = null) {
  const t = r.totals;
  const l = [`Paid-ad creative breakdown: ${t.ads} ad(s), ${t.byStatus.ready} analysed${t.withTimeline ? `, median ${sec(t.medianDurationSeconds)}, product at ${sec(t.medianProductAppearsAtSeconds)}` : ''}.`];
  if (r.ingredients.length) l.push(`Top ingredients: ${r.ingredients.slice(0, 5).map((x) => `${x.key} (${x.count})`).join(', ')}`);
  for (const x of diffLines(d).slice(0, 8)) l.push(`• ${x}`);
  return l.join('\n');
}
