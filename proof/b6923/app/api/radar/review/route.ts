import { env } from 'cloudflare:workers';
import { NextResponse } from 'next/server';
import { getChatGPTUser } from '../../../chatgpt-auth';
import { ownerDashboard, publishDraft, RadarError, revertPublication, scanSources, stageDraft } from '../../../radar/store';
import { stageReviewPacket } from '../../../radar/review-packet';
async function owner() {
  const user = await getChatGPTUser(), allowed = env.TENNISMOON_OWNER_EMAIL?.toLowerCase();
  return user && allowed && user.email.toLowerCase() === allowed ? user : null;
}
const headers = { 'Cache-Control': 'no-store' };
export async function GET() {
  if (!await owner()) return NextResponse.json({ error: 'Owner access required' }, { status: 403, headers });
  try { return NextResponse.json(await ownerDashboard(env.DB), { headers }); }
  catch { return NextResponse.json({ error: 'The Radar review database is unavailable or requires its explicit schema migration.' }, { status: 503, headers }); }
}
export async function POST(request: Request) {
  const user = await owner();
  if (!user) return NextResponse.json({ error: 'Owner access required' }, { status: 403, headers });
  const body = await request.json().catch(() => null) as { action?: string; id?: number; draft?: unknown; confirmEvidence?: boolean; packet?: unknown; playerName?: string; reviewedAt?: number } | null;
  if (!body) return NextResponse.json({ error: 'Invalid request body.' }, { status: 400, headers });
  try {
    if (body.action === 'import-packet') await stageReviewPacket(env.DB, body.packet, body.playerName || '', body.reviewedAt!);
    else if (body.action === 'draft') await stageDraft(env.DB, body.draft);
    else if (body.action === 'scan') await scanSources(env.DB);
    else if (body.action === 'publish' && Number.isInteger(body.id)) await publishDraft(env.DB, body.id!, user.email, body.confirmEvidence === true);
    else if (body.action === 'revert' && Number.isInteger(body.id)) await revertPublication(env.DB, body.id!, user.email);
    else if (body.action === 'reject-draft' && Number.isInteger(body.id)) await env.DB.prepare("UPDATE radar_update_proposals SET status = 'rejected', reviewed_at = ?, reviewed_by = ? WHERE id = ? AND status = 'pending'").bind(Date.now(), user.email, body.id).run();
    else if ((body.action === 'approve' || body.action === 'reject') && Number.isInteger(body.id)) await env.DB.prepare("UPDATE radar_review_queue SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ? AND status = 'pending'").bind(body.action === 'approve' ? 'approved' : 'rejected', Date.now(), user.email, body.id).run();
    else throw new RadarError('Invalid review action.');
    return NextResponse.json(await ownerDashboard(env.DB), { headers });
  } catch (error) {
    if (/no such table/i.test(String(error))) return NextResponse.json({ error: 'Apply the explicit Radar schema migration before using owner actions.' }, { status: 503, headers });
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Review action failed.' }, { status: error instanceof RadarError ? error.status : 400, headers });
  }
}
