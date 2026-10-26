import { env } from 'cloudflare:workers';
import { NextResponse } from 'next/server';
import { stageUnreviewed, verifyReader } from '../../../radar/intake';
import { RadarError } from '../../../radar/store';
/** Disabled by default. No publish/revert/owner actions are exposed to the reader. */
export async function POST(request: Request) {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    const identity = await verifyReader((request.headers.get('authorization') || '').replace(/^Bearer /, ''), { enabled: env.RADAR_INTAKE_ENABLED, repositoryId: env.RADAR_INTAKE_REPOSITORY_ID, ownerId: env.RADAR_INTAKE_OWNER_ID, workflowRef: env.RADAR_INTAKE_WORKFLOW_REF, audience: env.RADAR_INTAKE_AUDIENCE });
    const reader = request.body?.getReader(); if (!reader) throw new RadarError('A packet is required.');
    let body = '', size = 0; const decoder = new TextDecoder();
    try { while (true) { const r = await reader.read(); if (r.done) break; size += r.value.byteLength; if (size > 16000) throw new RadarError('Packet exceeds 16 KB.', 413); body += decoder.decode(r.value, { stream: true }); } body += decoder.decode(); }
    finally { await reader.cancel().catch(() => {}); }
    const result = await stageUnreviewed(env.DB, JSON.parse(body), identity.runId);
    return NextResponse.json(result, { status: result.replayed ? 200 : 201, headers });
  } catch (error) {
    // Auth can fail before consuming the body; release it before replying so later requests are not held up.
    if (request.body && !request.body.locked) await request.body.cancel().catch(() => {});
    return NextResponse.json({ error: error instanceof RadarError ? error.message : 'Intake unavailable or packet invalid.' }, { status: error instanceof RadarError ? error.status : error instanceof SyntaxError ? 400 : 503, headers }); }
}
