import { Claim, defaultSources, fallbackPlayers, FRESH_FOR_MS, officialUrl, RadarPlayer, trackedPlayers, validateDraft, validateCalendarContext, verifiedClaimTime } from './model';
import { FetchAttempt, fetchOfficialSource } from './fetch-source';
export class RadarError extends Error { constructor(message: string, public status = 400) { super(message); } }
type Entry = { player_key: string; payload: string };
type History = { id: number; player_key: string; previous_payload: string | null; published_payload: string; published_at: number; reverted_at: number | null };
type Attempt = { source_url: string; source_name: string; attempted_at: number; succeeded_at: number | null; http_status: number; content_hash: string | null; error_code: string | null };
async function optionalRows<T>(db: D1Database, sql: string): Promise<T[]> {
  try { return (await db.prepare(sql).all<T>()).results; }
  catch (error) { if (/no such table/i.test(String(error))) return []; throw error; }
}
async function fetchAttempts(db: D1Database): Promise<Attempt[]> {
  const recent = await optionalRows<Attempt>(db, 'SELECT source_url, source_name, attempted_at, succeeded_at, http_status, content_hash, error_code FROM radar_fetch_attempts WHERE id IN (SELECT MAX(id) FROM radar_fetch_attempts GROUP BY source_url) OR id IN (SELECT MAX(id) FROM radar_fetch_attempts WHERE succeeded_at IS NOT NULL GROUP BY source_url) ORDER BY attempted_at DESC, id DESC');
  // Legacy checks record attempts only. A historic HTTP status alone is not proof of a verified claim.
  const legacy = await optionalRows<{ source_url: string; source_name: string; checked_at: number; http_status: number }>(db, 'SELECT source_url, source_name, checked_at, http_status FROM radar_source_checks ORDER BY checked_at DESC');
  for (const row of legacy) if (!recent.some(a => a.source_url === row.source_url)) recent.push({ ...row, attempted_at: row.checked_at, succeeded_at: null, content_hash: null, error_code: row.http_status >= 200 && row.http_status < 300 ? null : `legacy-http-${row.http_status}` });
  return recent.sort((a, b) => b.attempted_at - a.attempted_at);
}
/** SELECT only, including on empty/old databases. No provisioning or repair on a public request. */
export async function readRadar(db: D1Database, now = Date.now()) {
  const rows = await optionalRows<Entry>(db, 'SELECT player_key, payload FROM radar_entries ORDER BY id ASC');
  const attempts = await fetchAttempts(db);
  const history = await optionalRows<History>(db, 'SELECT id, player_key, previous_payload, published_payload, published_at, reverted_at FROM radar_publication_history ORDER BY published_at DESC, id DESC LIMIT 300');
  // A quiet player's current approval must not disappear behind other players' newer history.
  const currentApprovals = await optionalRows<History>(db, 'SELECT id, player_key, previous_payload, published_payload, published_at, reverted_at FROM radar_publication_history WHERE id IN (SELECT MAX(h.id) FROM radar_publication_history h JOIN radar_entries e ON e.player_key = h.player_key AND e.payload = h.published_payload WHERE h.reverted_at IS NULL GROUP BY h.player_key)');
  for (const approval of currentApprovals) if (!history.some(h => h.id === approval.id)) history.push(approval);
  const players: RadarPlayer[] = fallbackPlayers().map(fallback => {
    const row = rows.find(r => r.player_key === fallback.name.toLowerCase());
    let claim: Claim = fallback;
    try { if (row) { const parsed = JSON.parse(row.payload); if (parsed?.name === fallback.name && parsed?.tour === fallback.tour) claim = parsed; } } catch { /* leave an explicitly unverified fallback */ }
    const verifiedAt = verifiedClaimTime(claim, now);
    let sourceUrl = fallback.sourceUrl, source = fallback.source;
    try { sourceUrl = officialUrl(claim.sourceUrl).href; if (typeof claim.source === 'string' && claim.source.trim()) source = claim.source; } catch { /* use the matching fallback URL and label together */ }
    const matching = attempts.filter(a => a.source_url === sourceUrl), latest = matching[0];
    const success = matching.find(a => a.succeeded_at !== null);
    const prior = history.filter(h => h.player_key === fallback.name.toLowerCase());
    const currentPublication = prior.find(h => h.published_payload === row?.payload && h.reverted_at === null);
    const claimStatus = verifiedAt === null ? 'Participation unconfirmed' : now - verifiedAt > FRESH_FOR_MS ? 'Stale' : 'Verified';
    const failed = !!latest?.error_code;
    let previousVerifiedClaim: Claim | undefined;
    for (const h of prior) {
      try { const candidate: Claim = JSON.parse(h.published_payload); if (h.published_payload !== row?.payload && verifiedClaimTime(candidate, now) !== null) { previousVerifiedClaim = candidate; break; } } catch { /* malformed history cannot become a public fact */ }
    }
    let calendarContext: Claim['calendarContext'];
    try { if (claim.calendarContext) calendarContext = validateCalendarContext(claim.calendarContext, now, true); } catch { /* expired context remains in history, not current public evidence */ }
    return { ...(verifiedAt === null ? fallback : claim), sourceUrl, source,
      // Retain explicit calendar evidence as context, without claiming player participation.
      ...(claim.schemaVersion === 2 && claim.status === 'Participation unconfirmed' && (!claim.calendarContext || calendarContext) ? { evidence: claim.evidence, schemaVersion: 2 } : {}),
      calendarContext,
      checked: verifiedAt === null ? 'Not verified' : new Date(verifiedAt).toISOString(),
      freshness: { status: failed ? 'Fetch failed' : claimStatus, claimStatus,
        lastSourceFetchAttemptAt: latest?.attempted_at ?? null, lastSuccessfulSourceFetchAt: success?.succeeded_at ?? null,
        lastVerifiedClaimAt: verifiedAt, lastApprovedPublicationAt: currentPublication?.published_at ?? null,
        sourceFetchFailed: failed, legacyChecked: verifiedAt === null && typeof claim.checked === 'string' && claim.checked !== 'Not verified' ? claim.checked : null },
      ...(previousVerifiedClaim ? { previousVerifiedClaim } : {}) };
  });
  return { players, freshnessPolicyHours: FRESH_FOR_MS / 3600000,
    lastSourceFetchAttemptAt: attempts[0]?.attempted_at ?? null,
    lastSuccessfulSourceFetchAt: attempts.reduce<number | null>((max, a) => a.succeeded_at === null ? max : Math.max(max ?? 0, a.succeeded_at), null) };
}
export async function stageDraft(db: D1Database, input: unknown, now = Date.now()) {
  const claim = validateDraft(input, now), key = claim.name.toLowerCase();
  if (claim.calendarContext) {
    validateCalendarContext(claim.calendarContext, now, true);
    const previous = await db.prepare("SELECT proposed_payload, status FROM radar_update_proposals WHERE player_key = ? AND json_extract(proposed_payload, '$.calendarContext.sourceUrl') = ? AND json_extract(proposed_payload, '$.calendarContext.revision') = ? ORDER BY id DESC").bind(key, claim.calendarContext.sourceUrl, claim.calendarContext.revision).all<{ proposed_payload: string; status: string }>();
    if (previous.results.length) {
      const context = claim.calendarContext;
      if (previous.results.some(p => p.status !== 'published')) throw new RadarError('This source revision was already staged or rejected for this player.', 409);
      const last = JSON.parse(previous.results[0].proposed_payload).calendarContext;
      const stale = now - last.reviewedAt > FRESH_FOR_MS || now - last.sourceCapturedAt > FRESH_FOR_MS || (typeof last.sourceRetrievedAt === 'number' && now - last.sourceRetrievedAt > FRESH_FOR_MS);
      if (!stale || !context.sourceRetrievedAt || context.sourceRetrievedAt <= last.reviewedAt || context.sourceCapturedAt <= last.sourceCapturedAt || context.packetHash === last.packetHash) throw new RadarError('This source revision was already published; renewal needs stale verification and a new successful retrieval.', 409);
      const fields = ['event', 'city', 'start', 'end', 'dateExcerpt', 'locationExcerpt', 'sourcePublishedAt', 'license'];
      // Legacy reader footers expose minutes; the native API may refine seconds within that same minute.
      if (context.sourceModifiedAt !== last.sourceModifiedAt && !(typeof context.sourceModifiedAt === 'number' && typeof last.sourceModifiedAt === 'number' && (context.sourceModifiedAt % 60000 === 0 || last.sourceModifiedAt % 60000 === 0) && Math.floor(context.sourceModifiedAt / 60000) === Math.floor(last.sourceModifiedAt / 60000))) throw new RadarError('An unchanged revision cannot change its original source date.');
      if (fields.some(k => context[k as keyof typeof context] !== last[k])) throw new RadarError('An unchanged revision cannot change its source facts or original dates.');
    }
  }
  const current = await db.prepare('SELECT payload FROM radar_entries WHERE player_key = ?').bind(key).first<{ payload: string }>();
  const result = await db.prepare("INSERT INTO radar_update_proposals (player_key, current_payload, proposed_payload, evidence_url, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)").bind(key, current?.payload ?? null, JSON.stringify(claim), claim.sourceUrl, now).run();
  return result.meta.last_row_id;
}
export async function publishDraft(db: D1Database, id: number, reviewer: string, confirmed: boolean, now = Date.now()) {
  if (!confirmed) throw new RadarError('Review the quoted official evidence and explicitly confirm that it supports this player update.');
  const proposal = await db.prepare("SELECT proposed_payload, current_payload FROM radar_update_proposals WHERE id = ? AND status = 'pending'").bind(id).first<{ proposed_payload: string; current_payload: string | null }>();
  if (!proposal) throw new RadarError('Draft is no longer pending.', 409);
  const raw = JSON.parse(proposal.proposed_payload) as Claim;
  if (raw.schemaVersion !== 2) throw new RadarError('This legacy draft has no verified evidence contract. Create a new evidence-backed draft.');
  const claim = validateDraft(raw, now);
  if (claim.calendarContext) validateCalendarContext(claim.calendarContext, now, true);
  const withoutContext = (c: Claim) => { const { calendarContext: ignored, ...main } = c; return JSON.stringify(main); };
  let contextOnly = false;
  try { contextOnly = !!claim.calendarContext && !!proposal.current_payload && withoutContext(raw) === withoutContext(JSON.parse(proposal.current_payload)); } catch { /* malformed snapshots cannot authorize an exception */ }
  if (!contextOnly && now - claim.evidence!.verifiedAt > FRESH_FOR_MS) throw new RadarError('Evidence review is older than 48 hours. Recheck the source and prepare a fresh draft.');
  // D1 batch is transactional. Only the winner of the exact-payload compare-and-swap can write.
  const results = await db.batch([
    db.prepare("UPDATE radar_update_proposals SET status = 'publishing' WHERE id = ? AND status = 'pending' AND current_payload IS (SELECT payload FROM radar_entries WHERE player_key = radar_update_proposals.player_key)").bind(id),
    db.prepare("INSERT INTO radar_publication_history (player_key, previous_payload, published_payload, published_at, published_by) SELECT player_key, current_payload, proposed_payload, ?, ? FROM radar_update_proposals WHERE id = ? AND status = 'publishing'").bind(now, reviewer, id),
    db.prepare("INSERT INTO radar_entries (player_key, payload, updated_at) SELECT player_key, proposed_payload, ? FROM radar_update_proposals WHERE id = ? AND status = 'publishing' ON CONFLICT(player_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at").bind(now, id),
    db.prepare("UPDATE radar_update_proposals SET status = 'published', reviewed_at = ?, reviewed_by = ? WHERE id = ? AND status = 'publishing'").bind(now, reviewer, id),
  ]);
  if (!results[0].meta.changes) throw new RadarError('Player information changed after this draft was prepared. Review the latest record and create a new draft.', 409);
}
export async function recordAttempt(db: D1Database, attempt: FetchAttempt) {
  const inserted = await db.prepare('INSERT INTO radar_fetch_attempts (source_url, source_name, attempted_at, succeeded_at, http_status, content_hash, error_code) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(attempt.sourceUrl, attempt.sourceName, attempt.attemptedAt, attempt.succeededAt, attempt.httpStatus, attempt.contentHash, attempt.errorCode).run();
  if (!attempt.succeededAt || !attempt.contentHash) return;
  const previous = await db.prepare('SELECT content_hash FROM radar_fetch_attempts WHERE source_url = ? AND succeeded_at IS NOT NULL AND id < ? ORDER BY attempted_at DESC, id DESC LIMIT 1').bind(attempt.sourceUrl, inserted.meta.last_row_id).first<{ content_hash: string }>();
  if (previous?.content_hash && previous.content_hash !== attempt.contentHash) {
    await db.prepare("INSERT INTO radar_review_queue (source_url, source_name, summary, previous_hash, proposed_hash, status, created_at) SELECT ?, ?, ?, ?, ?, 'pending', ? WHERE NOT EXISTS (SELECT 1 FROM radar_review_queue WHERE source_url = ? AND status = 'pending')").bind(attempt.sourceUrl, attempt.sourceName, 'Official source content changed. Review evidence and prepare a player draft; this is not a participation confirmation.', previous.content_hash, attempt.contentHash, attempt.attemptedAt, attempt.sourceUrl).run();
  }
}
export async function scanSources(db: D1Database, fetcher: typeof fetch = fetch) {
  const sources = [...defaultSources], rows = await db.prepare('SELECT payload FROM radar_entries ORDER BY id ASC').all<{ payload: string }>();
  for (const row of rows.results) {
    try { const claim: Claim = JSON.parse(row.payload), url = officialUrl(claim.sourceUrl).href; if (!sources.some(s => s.url === url) && sources.length < 6) sources.push({ url, name: claim.source }); } catch { /* only approved hosts may be fetched */ }
  }
  for (const source of sources) await recordAttempt(db, await fetchOfficialSource(source, fetcher));
}
export async function ownerDashboard(db: D1Database) {
  const [radar, attempts, queue, proposals, history, intake] = await Promise.all([
    readRadar(db), fetchAttempts(db),
    db.prepare("SELECT id, source_url AS sourceUrl, source_name AS sourceName, summary, status, created_at AS createdAt FROM radar_review_queue WHERE status = 'pending' ORDER BY created_at DESC").all(),
    db.prepare("SELECT id, player_key AS playerKey, current_payload AS currentPayload, proposed_payload AS proposedPayload, evidence_url AS evidenceUrl, created_at AS createdAt FROM radar_update_proposals WHERE status = 'pending' ORDER BY created_at DESC").all(),
    db.prepare('SELECT id, player_key AS playerKey, published_payload AS publishedPayload, published_at AS publishedAt, published_by AS publishedBy, reverted_at AS revertedAt FROM radar_publication_history ORDER BY published_at DESC LIMIT 12').all(),
    optionalRows<{id:string;payload:string;created_at:number}>(db,'SELECT id,payload,created_at FROM radar_intake_packets ORDER BY created_at DESC LIMIT 20'),
  ]);
  return { ...radar, intake: intake.map(r => ({id:r.id,packet:JSON.parse(r.payload),receivedAt:r.created_at})), checks: attempts.filter((a, i) => attempts.findIndex(b => a.source_url === b.source_url) === i).map(a => ({ sourceUrl: a.source_url, sourceName: a.source_name, httpStatus: a.http_status, checkedAt: a.attempted_at, lastSuccessAt: attempts.find(b => b.source_url === a.source_url && b.succeeded_at !== null)?.succeeded_at ?? null, error: a.error_code })),
    queue: queue.results, proposals: proposals.results.map(row => ({ ...row, currentPayload: row.currentPayload ? JSON.parse(String(row.currentPayload)) : null, proposedPayload: JSON.parse(String(row.proposedPayload)) })),
    history: history.results.map(row => ({ ...row, publishedPayload: JSON.parse(String(row.publishedPayload)) })) };
}
export async function revertPublication(db: D1Database, id: number, reviewer: string, now = Date.now()) {
  const item = await db.prepare('SELECT previous_payload FROM radar_publication_history WHERE id = ? AND reverted_at IS NULL').bind(id).first<{ previous_payload: string | null }>();
  if (!item?.previous_payload) throw new RadarError('This publication has no restorable previous record.', 409);
  const results = await db.batch([
    db.prepare('UPDATE radar_publication_history SET reverted_at = ?, reverted_by = ? WHERE id = ? AND reverted_at IS NULL AND id = (SELECT MAX(h.id) FROM radar_publication_history h WHERE h.player_key = radar_publication_history.player_key AND h.reverted_at IS NULL) AND published_payload IS (SELECT payload FROM radar_entries WHERE player_key = radar_publication_history.player_key)').bind(now, reviewer, id),
    db.prepare('INSERT INTO radar_write_permits(player_key,old_payload,new_payload) SELECT player_key,published_payload,previous_payload FROM radar_publication_history WHERE id = ? AND reverted_at = ? AND reverted_by = ?').bind(id, now, reviewer),
    db.prepare('UPDATE radar_entries SET payload = (SELECT previous_payload FROM radar_publication_history WHERE id = ?), updated_at = ? WHERE player_key = (SELECT player_key FROM radar_publication_history WHERE id = ? AND reverted_at = ? AND reverted_by = ?)').bind(id, now, id, now, reviewer),
    db.prepare('DELETE FROM radar_write_permits WHERE player_key = (SELECT player_key FROM radar_publication_history WHERE id = ?)').bind(id),
  ]);
  if (!results[0].meta.changes) throw new RadarError('A newer publication exists; an older history item cannot overwrite it.', 409);
}
