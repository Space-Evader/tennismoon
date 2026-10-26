import { fallbackPlayers, validateCalendarContext, verifiedClaimTime, Claim } from './model';
import { RadarError, stageDraft } from './store';
/** Owner-only staging adapter. Core packet hashes provide lineage, never authorization or truth. */
export async function stageReviewPacket(db: D1Database, value: unknown, playerName: string, reviewedAt: number, now = Date.now()) {
  const packet = value as { schema?: string; canonical?: boolean; synthetic?: boolean; owner_approved?: boolean; context?: unknown } | null;
  if (!packet || JSON.stringify(packet).length > 16000 || packet.schema !== 'tennis.radar-review/1' || packet.canonical !== false || packet.synthetic !== false || packet.owner_approved !== false) throw new RadarError('An unapproved, real public-source review packet is required. No Gmail content is accepted.');
  const context = validateCalendarContext({ ...(packet.context as object), reviewedAt }, now, true);
  const player = fallbackPlayers().find(p => p.name === playerName);
  if (!player) throw new RadarError('Select an existing player card for general calendar context.');
  const existing = await db.prepare('SELECT payload FROM radar_entries WHERE player_key = ?').bind(player.name.toLowerCase()).first<{ payload: string }>();
  let current: Claim | undefined;
  try { if (existing) { const parsed = JSON.parse(existing.payload); if (verifiedClaimTime(parsed, now) !== null) current = parsed; } } catch { /* no unsupported legacy evidence reused */ }
  // A calendar must never replace a previously verified player claim with a calendar assertion.
  const draft = current ? { ...current, calendarContext: context } : {
    ...player, event: context.event, city: context.city, date: `${context.start} – ${context.end}`,
    status: 'Participation unconfirmed', source: 'Wikipedia contributors (secondary calendar)', sourceUrl: context.sourceUrl,
    evidence: { kind: 'calendar', quote: `${context.event}\n${context.dateExcerpt}\n${context.locationExcerpt}`, verifiedAt: reviewedAt }, calendarContext: context,
  };
  return stageDraft(db, draft, now);
}
