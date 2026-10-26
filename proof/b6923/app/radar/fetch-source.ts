import { officialUrl } from './model';
export type FetchAttempt = { sourceUrl: string; sourceName: string; attemptedAt: number; succeededAt: number | null; httpStatus: number; contentHash: string | null; errorCode: string | null };
/** Availability/change monitor only. It does not infer player facts or publish. */
export async function fetchOfficialSource(source: { url: string; name: string }, fetcher: typeof fetch = fetch, clock = Date.now): Promise<FetchAttempt> {
  const attempt: FetchAttempt = { sourceUrl: source.url, sourceName: source.name, attemptedAt: clock(), succeededAt: null, httpStatus: 0, contentHash: null, errorCode: null };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
  try {
    let url = officialUrl(source.url);
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 2; redirects++) {
      response = await fetcher(url.href, { redirect: 'manual', signal: controller.signal, cache: 'no-store', headers: { 'user-agent': 'TennisMoonSourceMonitor/2.0 (+https://tennismoon.com)' } });
      attempt.httpStatus = response.status;
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const target = response.headers.get('location');
      await response.body?.cancel();
      if (!target || redirects === 2) throw new Error('redirect-limit');
      const next = officialUrl(new URL(target, url).href);
      if (next.hostname.replace(/^www\./, '') !== url.hostname.replace(/^www\./, '')) throw new Error('cross-source-redirect');
      url = next;
    }
    if (!response?.ok) throw new Error(`http-${response?.status ?? 0}`);
    const type = response.headers.get('content-type') || '';
    if (!/text\/|application\/(json|xhtml\+xml)/i.test(type)) throw new Error('unsupported-content-type');
    if (Number(response.headers.get('content-length') || 0) > 524288) throw new Error('body-too-large');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('empty-body');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 524288) throw new Error('body-too-large'); chunks.push(value); }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body = new TextDecoder().decode(bytes).replace(/\s+/g, ' ').trim();
    if (body.length < 30) throw new Error('empty-or-incomplete-content');
    if (/cf-chl-|just a moment|access denied|captcha|verify you are human/i.test(body)) throw new Error('challenge-page');
    attempt.contentHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))).map(n => n.toString(16).padStart(2, '0')).join('');
    attempt.succeededAt = clock();
  } catch (error) {
    attempt.errorCode = controller.signal.aborted ? 'timeout' : error instanceof Error ? error.message.slice(0, 160) : 'fetch-failed';
  } finally { clearTimeout(timer); controller.abort(); }
  return attempt;
}
