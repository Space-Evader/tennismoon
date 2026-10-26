import { validateCalendarContext, FRESH_FOR_MS } from './model';
import { RadarError } from './store';
export type IntakePolicy = { enabled?: string; repositoryId?: string; ownerId?: string; workflowRef?: string; audience?: string };
const issuer = 'https://token.actions.githubusercontent.com';
const decode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
/** Service identity only. Never creates a ChatGPT owner identity or authorizes publication. */
export async function verifyReader(token: string, policy: IntakePolicy, now = Date.now(), fetcher: typeof fetch = fetch) {
  if (policy.enabled !== 'true' || !policy.repositoryId || !policy.ownerId || !policy.workflowRef || !policy.audience) throw new RadarError('Daily intake is disabled or unconfigured.', 503);
  try {
    if (token.length > 12000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error();
    const parts = token.split('.'), header = JSON.parse(new TextDecoder().decode(decode(parts[0]))), claims = JSON.parse(new TextDecoder().decode(decode(parts[1])));
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 150) throw new Error();
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 4000);
    async function bounded(url: string) {
      const response = await fetcher(url, { signal: controller.signal, redirect: 'error' });
      if (!response.ok) throw new RadarError('Reader identity service unavailable.', 503);
      if (!response.headers.get('content-type')?.includes('application/json') || Number(response.headers.get('content-length') || 0) > 20000) throw new Error();
      const reader = response.body?.getReader(); if (!reader) throw new Error(); let size = 0, text = ''; const decoder = new TextDecoder();
      try { while (true) { const r = await reader.read(); if (r.done) break; size += r.value.byteLength; if (size > 20000) throw new Error(); text += decoder.decode(r.value, { stream: true }); } return JSON.parse(text + decoder.decode()); }
      finally { await reader.cancel().catch(() => {}); }
    }
    let keys;
    try {
      const metadata = await bounded(issuer + '/.well-known/openid-configuration');
      const url = new URL(metadata.jwks_uri);
      if (metadata.issuer !== issuer || url.origin !== issuer || url.username || url.password || url.search || url.hash) throw new Error();
      keys = await bounded(url.href);
    } finally { clearTimeout(timer); }
    const key = keys.keys?.find((k: JsonWebKey & { kid?: string }) => k.kid === header.kid && k.kty === 'RSA' && (!k.alg || k.alg === 'RS256'));
    if (!key?.n || decode(key.n).length < 256) throw new Error();
    const imported = await crypto.subtle.importKey('jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', imported, decode(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]))) throw new Error();
    const seconds = now / 1000;
    if (claims.iss !== issuer || claims.aud !== policy.audience || claims.repository_id !== policy.repositoryId || claims.repository_owner_id !== policy.ownerId || claims.workflow_ref !== policy.workflowRef || !policy.workflowRef.endsWith('@' + claims.ref) || !['workflow_dispatch', 'schedule'].includes(claims.event_name) || typeof claims.run_id !== 'string') throw new Error();
    if (![claims.exp, claims.iat, claims.nbf].every(Number.isFinite) || claims.exp <= seconds || claims.iat > seconds + 30 || claims.nbf > seconds + 30 || claims.exp - claims.iat > 600 || claims.exp <= claims.iat) throw new Error();
    return { runId: claims.run_id as string };
  } catch (error) { if (error instanceof RadarError) throw error; throw new RadarError('Reader authentication failed.', 401); }
}
export async function stageUnreviewed(db: D1Database, input: unknown, runId: string, now = Date.now()) {
  const p = input as { schema?: string; canonical?: boolean; synthetic?: boolean; owner_approved?: boolean; context?: Record<string, unknown> };
  if (!p || JSON.stringify(p).length > 16000 || Object.keys(p).some(k => !['schema', 'canonical', 'synthetic', 'owner_approved', 'context'].includes(k)) || p.schema !== 'tennis.radar-review/1' || p.canonical !== false || p.synthetic !== false || p.owner_approved !== false || p.context?.reviewedAt !== null) throw new RadarError('Only an unreviewed public calendar packet is accepted.');
  const context = validateCalendarContext({ ...p.context, reviewedAt: now }, now, true);
  if (!context.sourceRetrievedAt || now - context.sourceRetrievedAt > FRESH_FOR_MS) throw new RadarError('A recent successful retrieval is required for unattended intake.');
  // The temporary validation clock is NOT an owner review and is never persisted as one.
  const packet = { schema: p.schema, canonical: false, synthetic: false, owner_approved: false, context: { ...context, reviewedAt: null } };
  const hash = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
  const id = await hash(JSON.stringify([context.sourceUrl, context.revision, context.sourceCapturedAt])), payload = JSON.stringify(packet);
  let result;
  try { result = await db.prepare('INSERT INTO radar_intake_packets(id,payload,created_at,reader_run_id) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING').bind(id, payload, now, runId).run(); } catch (error) { if (/Reader run packet limit/.test(String(error))) throw new RadarError('Reader run packet limit exceeded.', 429); throw error; }
  const saved = await db.prepare('SELECT payload FROM radar_intake_packets WHERE id=?').bind(id).first<{payload:string}>();
  if (saved?.payload !== payload) throw new RadarError('This observation identity already has different evidence.', 409);
  return { id, replayed: !result.meta.changes, status: 'unreviewed', published: false, canonical: false };
}
