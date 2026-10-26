/** Public Radar contract and evidence policy; contains no credentials or database writes. */
export const FRESH_FOR_MS = 48 * 60 * 60 * 1000;
export const trackedPlayers = [
  { name: 'Carlos Alcaraz', tour: 'ATP', country: 'Spain', flag: '🇪🇸' },
  { name: 'Jannik Sinner', tour: 'ATP', country: 'Italy', flag: '🇮🇹' },
  { name: 'Coco Gauff', tour: 'WTA', country: 'United States', flag: '🇺🇸' },
  { name: 'Iga Świątek', tour: 'WTA', country: 'Poland', flag: '🇵🇱' },
] as const;
export type EvidenceKind = 'calendar' | 'entry-list' | 'draw' | 'order-of-play' | 'player-announcement' | 'result';
export type Evidence = { kind: EvidenceKind; quote: string; verifiedAt: number; method: 'owner-reviewed' };
export type CalendarContext = {
  schema: 'tennis.calendar-context/1'; packetHash: string; sourceUrl: string; revision: string;
  event: string; city: string; start: string; end: string; dateExcerpt: string; locationExcerpt: string;
  sourceCapturedAt: number; sourceRetrievedAt?: number | null; sourceModifiedAt: number | null; sourcePublishedAt: number | null;
  reviewedAt: number; attribution: string; license: 'CC-BY-SA-4.0';
};
export type Claim = {
  name: string; tour: string; country: string; flag: string; event: string; city: string;
  date: string; status: string; checked: string; source: string; sourceUrl: string;
  calendarContext?: CalendarContext; shopUrl?: string; shopLabel?: string; schemaVersion?: number; evidence?: Evidence;
};
export type Freshness = {
  status: 'Verified' | 'Stale' | 'Fetch failed' | 'Participation unconfirmed';
  claimStatus: 'Verified' | 'Stale' | 'Participation unconfirmed';
  lastSourceFetchAttemptAt: number | null; lastSuccessfulSourceFetchAt: number | null;
  lastVerifiedClaimAt: number | null; lastApprovedPublicationAt: number | null;
  sourceFetchFailed: boolean; legacyChecked: string | null;
};
export type RadarPlayer = Claim & { freshness: Freshness; previousVerifiedClaim?: Claim };
export const defaultSources = [
  { name: 'Official ATP tournament schedule', url: 'https://www.atptour.com/en/tournaments' },
  { name: 'Official WTA tournament schedule', url: 'https://www.wtatennis.com/tournaments' },
];
const officialHosts = new Set(['atptour.com', 'www.atptour.com', 'wtatennis.com', 'www.wtatennis.com', 'usopen.org', 'www.usopen.org']);
export function officialUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !officialHosts.has(url.hostname)) throw new Error('Use an approved official ATP, WTA, or US Open HTTPS evidence URL.');
  url.hash = '';
  return url;
}
const normalized = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function text(obj: Record<string, unknown>, key: string, max = 180) {
  const value = obj[key];
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(`Complete ${key} (maximum ${max} characters).`);
  return value.trim();
}
/** Validates shape/support rules; semantic truth still requires the owner's evidence review. */
export function validateDraft(value: unknown, now: number): Claim {
  const input = record(value), player = trackedPlayers.find(p => p.name === input.name);
  if (!player || input.tour !== player.tour) throw new Error('Select one of the four existing players and the correct tour.');
  const event = text(input, 'event'), city = text(input, 'city'), date = text(input, 'date'), status = text(input, 'status');
  const context = input.calendarContext === undefined ? undefined : validateCalendarContext(input.calendarContext, now);
  const sourceUrl = context && input.status === 'Participation unconfirmed' && input.sourceUrl === context.sourceUrl ? new URL(context.sourceUrl) : officialUrl(text(input, 'sourceUrl', 500));
  if ((player.tour === 'ATP' && sourceUrl.hostname.endsWith('wtatennis.com')) || (player.tour === 'WTA' && sourceUrl.hostname.endsWith('atptour.com'))) throw new Error('Evidence must match the player’s tour.');
  const evidence = record(input.evidence), kind = text(evidence, 'kind') as EvidenceKind;
  const quote = text(evidence, 'quote', 2400);
  const verifiedAt = typeof evidence.verifiedAt === 'number' ? evidence.verifiedAt : Date.parse(String(evidence.verifiedAt ?? ''));
  if (!Number.isFinite(verifiedAt) || verifiedAt <= 0 || verifiedAt > now) throw new Error('Enter the actual evidence-review time; future dates are not permitted.');
  const kinds: Record<string, EvidenceKind[]> = {
    'Entry list': ['entry-list'], 'Announced': ['player-announcement'], 'Draw confirmed': ['draw'],
    'Scheduled': ['order-of-play'], 'Withdrawn': ['player-announcement'], 'Completed': ['result'],
    'Participation unconfirmed': ['calendar'],
  };
  if (!kinds[status]?.includes(kind)) throw new Error('The evidence type does not support this status. Live-playing claims are not supported.');
  const generalCalendar = /\/(?:en\/)?tournaments\/?$/.test(sourceUrl.pathname);
  if (status !== 'Participation unconfirmed') {
    if (generalCalendar) throw new Error('A general tournament calendar cannot confirm a player’s participation.');
    const paths: Record<string, RegExp> = {
      'entry-list': /entry|acceptance|player|field/i, 'draw': /draw/i, 'order-of-play': /schedule|order.of.play/i,
      'player-announcement': /news|article|announcement|update/i, 'result': /result|score|draw/i,
    };
    if (!paths[kind]?.test(sourceUrl.pathname)) throw new Error('Use a specific official entry list, draw, order of play, announcement, or result page.');
    if (status !== 'Withdrawn' && /withdrawn|withdraws|will not (?:play|compete)|not (?:entered|participating)|not confirmed/i.test(quote)) throw new Error('The excerpt contradicts the proposed participation status.');
    const proof = normalized(quote);
    for (const needed of [player.name, event, city, date]) if (!proof.includes(normalized(needed))) throw new Error('The evidence excerpt must identify the player, displayed event, city, and displayed dates.');
    if (status === 'Withdrawn' && !/withdraw|will not play|will not compete|pulls out/i.test(quote)) throw new Error('Withdrawal evidence must explicitly support withdrawal.');
  }
  if (quote.length < 30) throw new Error('Include a meaningful official evidence excerpt (at least 30 characters).');
  return { ...player, event, city, date, status,
    checked: status === 'Participation unconfirmed' ? 'Not verified' : new Date(verifiedAt).toISOString(),
    source: text(input, 'source', 140), sourceUrl: sourceUrl.href, schemaVersion: 2,
    evidence: { kind, quote, verifiedAt, method: 'owner-reviewed' }, ...(context ? { calendarContext: context } : {}) };
}
export function verifiedClaimTime(claim: Claim, now = Date.now()): number | null {
  if (claim.schemaVersion !== 2 || !claim.evidence || claim.status === 'Participation unconfirmed') return null;
  try { return validateDraft(claim, now).evidence!.verifiedAt; } catch { return null; }
}
export function fallbackPlayers(): RadarPlayer[] {
  return trackedPlayers.map(player => ({ ...player, event: 'Participation not confirmed', city: 'To be announced',
    date: 'Check official tour schedule', status: 'Participation unconfirmed', checked: 'Not verified',
    source: `Official ${player.tour} schedule`, sourceUrl: defaultSources[player.tour === 'ATP' ? 0 : 1].url,
    freshness: { status: 'Participation unconfirmed', claimStatus: 'Participation unconfirmed', lastSourceFetchAttemptAt: null,
      lastSuccessfulSourceFetchAt: null, lastVerifiedClaimAt: null, lastApprovedPublicationAt: null,
      sourceFetchFailed: false, legacyChecked: null } }));
}
export function formatRadarTime(value: number | null) {
  return value === null ? 'Not recorded' : new Date(value).toISOString().replace('T', ' ').replace(/:\d\d\.\d{3}Z$/, ' UTC');
}

/** Narrow reuse policy: attributed calendar context only, never evidence of player participation. */
export function validateCalendarContext(value: unknown, now: number, requireFresh = false): CalendarContext {
  const c = record(value), url = new URL(text(c, 'sourceUrl', 500));
  if (url.protocol !== 'https:' || url.hostname !== 'en.wikipedia.org' || url.username || url.password || url.port || url.search || url.hash || !/^\/wiki\/20[0-9]{2}_[A-Za-z0-9_()-]+$/.test(url.pathname)) throw new Error('Only explicit public Wikipedia tournament articles are supported for calendar context.');
  if (c.schema !== 'tennis.calendar-context/1' || c.license !== 'CC-BY-SA-4.0' || !/^[a-f0-9]{64}$/.test(String(c.packetHash)) || !/^[1-9][0-9]{0,15}$/.test(String(c.revision))) throw new Error('Review packet, revision and supported reuse license required.');
  const start = text(c, 'start'), end = text(c, 'end');
  for (const date of [start, end]) if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date) throw new Error('Exact valid calendar dates required.');
  if (end < start || (requireFresh && end < new Date(now).toISOString().slice(0,10))) throw new Error('Historical or reversed calendars cannot be newly published.');
  function time(key: string, optional = false): number | null {
    if (optional && c[key] === null) return null;
    const t = c[key];
    if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0 || t > now) throw new Error(`Actual ${key} required; future times are prohibited.`);
    return t;
  }
  const event = text(c, 'event'), city = text(c, 'city'), dateExcerpt = text(c, 'dateExcerpt', 300), locationExcerpt = text(c, 'locationExcerpt', 300);
  const label = (date: string) => { const d = new Date(date); return `${d.getUTCDate()} ${d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })}`; };
  const dateMatch = dateExcerpt.match(/^Date\s*\|\s*(\d+ [A-Za-z]+)[–—-](\d+ [A-Za-z]+)$/);
  if (!dateMatch || dateMatch[1] !== label(start) || dateMatch[2] !== label(end) || !event.startsWith(start.slice(0,4) + ' ') || start.slice(0,4) !== end.slice(0,4) || event.replaceAll(' ', '_') !== decodeURIComponent(url.pathname.slice(6)) || !/^Location\s*\|/.test(locationExcerpt) || locationExcerpt.split('|')[1].trim() !== city) throw new Error('Calendar title, dates and location must match the exact evidence excerpts.');
  if (text(c, 'attribution', 700) !== `${event} — Wikipedia contributors; ${url.href}`) throw new Error('Original contributor attribution required.');
  const sourceCapturedAt = time('sourceCapturedAt')!, reviewedAt = time('reviewedAt')!;
  const sourceRetrievedAt = c.sourceRetrievedAt === undefined ? null : time('sourceRetrievedAt', true);
  if (sourceRetrievedAt !== null && sourceRetrievedAt > sourceCapturedAt) throw new Error('Retrieval must complete before capture.');
  const sourceModifiedAt = time('sourceModifiedAt', true), sourcePublishedAt = time('sourcePublishedAt', true);
  if (sourceRetrievedAt !== null && sourceModifiedAt !== null && sourceModifiedAt > sourceRetrievedAt) throw new Error('Source modification cannot follow the successful retrieval.');
  if (requireFresh && sourceRetrievedAt !== null && now - sourceRetrievedAt > FRESH_FOR_MS) throw new Error('Successful retrieval is stale (48 hours).');
  if (reviewedAt < sourceCapturedAt || (sourceModifiedAt !== null && sourceModifiedAt > sourceCapturedAt) || (sourcePublishedAt !== null && sourcePublishedAt > sourceCapturedAt)) throw new Error('Source/review timestamps are inconsistent.');
  // Source age and review age are separate: re-review cannot freshen an old capture.
  if (requireFresh && (now - sourceCapturedAt > FRESH_FOR_MS || now - reviewedAt > FRESH_FOR_MS)) throw new Error('Calendar capture or owner review is stale (48 hours).');
  return { schema: 'tennis.calendar-context/1', packetHash: String(c.packetHash), sourceUrl: url.href, revision: String(c.revision),
    event: text(c, 'event'), city: text(c, 'city'), start, end, dateExcerpt: text(c, 'dateExcerpt', 300), locationExcerpt: text(c, 'locationExcerpt', 300),
    sourceCapturedAt, sourceRetrievedAt, sourceModifiedAt, sourcePublishedAt, reviewedAt, attribution: text(c, 'attribution', 700), license: 'CC-BY-SA-4.0' };
}
