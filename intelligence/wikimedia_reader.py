"""Bounded free Wikipedia calendar reader. Emits unreviewed Radar packets; never publishes.
Uses immutable revision HTML plus API rights metadata. No Gmail, scores, credentials or Core service.
"""
import argparse
import hashlib
from html.parser import HTMLParser
import json
import re
from datetime import datetime, timezone
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen, build_opener, HTTPRedirectHandler

HOST = 'en.wikipedia.org'
UA = 'TennisMoonReadiness/1.0 (https://github.com/Space-Evader/tennismoon)'


class Calendar(HTMLParser):
    def __init__(self):
        super().__init__(); self.rows = {}; self.label = []; self.value = []; self.cell = None; self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag == 'tr': self.label = []; self.value = []
        if tag in ('th', 'td'): self.cell = tag
        if tag in ('sup', 'script', 'style'): self.skip += 1

    def handle_endtag(self, tag):
        if tag in ('sup', 'script', 'style'): self.skip = max(0, self.skip - 1)
        if tag in ('th', 'td'): self.cell = None
        if tag == 'tr':
            label = ' '.join(''.join(self.label).split())
            value = ' '.join(''.join(self.value).split())
            if label in ('Date', 'Location') and value and label not in self.rows: self.rows[label] = value

    def handle_data(self, value):
        if not self.skip and self.cell: (self.label if self.cell == 'th' else self.value).append(value)


def fetch_json(params):
    url = 'https://' + HOST + '/w/api.php?' + urlencode(params | {'format': 'json', 'formatversion': 2})
    with urlopen(Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'}), timeout=12) as response:
        destination = urlsplit(response.url)
        if destination.scheme != 'https' or destination.hostname != HOST or response.status != 200:
            raise ValueError('Source retrieval failed or changed host')
        if 'application/json' not in response.headers.get('Content-Type', ''): raise ValueError('Expected JSON source response')
        body = response.read(512001)
        if len(body) > 512000: raise ValueError('Source response exceeds bound')
        value = json.loads(body)
        if 'error' in value: raise ValueError('Source API reported an error')
        return value


def read_calendar(title, fetcher=fetch_json, clock=lambda: datetime.now(timezone.utc)):
    if not re.fullmatch(r'20[0-9]{2}_[A-Za-z0-9_()-]+', title): raise ValueError('An explicit public tournament article is required')
    metadata = fetcher({'action': 'query', 'prop': 'revisions', 'titles': title, 'rvprop': 'ids|timestamp'})
    page = metadata['query']['pages'][0]
    if page.get('missing'): raise ValueError('Source article unavailable')
    revision = page['revisions'][0]
    content = fetcher({'action': 'parse', 'oldid': str(revision['revid']), 'prop': 'text'})['parse']
    rights = fetcher({'action': 'query', 'meta': 'siteinfo', 'siprop': 'rightsinfo'})['query']['rightsinfo']
    if not rights.get('url', '').startswith('https://creativecommons.org/licenses/by-sa/4.0/'):
        raise ValueError('Supported reuse license not confirmed')
    if content['title'].replace(' ', '_') != title or content['revid'] != revision['revid']:
        raise ValueError('Revision HTML and source identity disagree')
    parser = Calendar(); parser.feed(content['text']); rows = parser.rows
    dates = re.fullmatch(r'(\d+) ([A-Za-z]+)[–—-](\d+) ([A-Za-z]+)', rows.get('Date', ''))
    if not dates or not rows.get('Location'): raise ValueError('No supported calendar evidence; do not infer missing dates/location')
    year = title[:4]
    start = datetime.strptime(f'{dates[1]} {dates[2]} {year}', '%d %B %Y').date().isoformat()
    end = datetime.strptime(f'{dates[3]} {dates[4]} {year}', '%d %B %Y').date().isoformat()
    retrieved = clock(); captured = clock()
    if retrieved.tzinfo is None or captured.tzinfo is None or captured < retrieved: raise ValueError('Consistent timezone-aware observation clocks required')
    modified = datetime.fromisoformat(revision['timestamp'].replace('Z', '+00:00'))
    if modified > retrieved or end < captured.date().isoformat() or end < start: raise ValueError('Historical or inconsistent source dates')
    source_url = 'https://' + HOST + '/wiki/' + title
    proof = {'origin': 'wikipedia-action-api', 'source_url': source_url, 'source_revision': revision['revid'], 'source_modified_at': revision['timestamp'], 'rows': rows, 'reader_retrieved_at': retrieved.isoformat(), 'captured_at': captured.isoformat(), 'rights': rights}
    packet_hash = hashlib.sha256(json.dumps(proof, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return {'schema': 'tennis.radar-review/1', 'canonical': False, 'synthetic': False, 'owner_approved': False,
            'context': {'schema': 'tennis.calendar-context/1', 'packetHash': packet_hash, 'sourceUrl': source_url,
                        'revision': str(revision['revid']), 'event': content['title'], 'city': rows['Location'], 'start': start, 'end': end,
                        'dateExcerpt': 'Date  | ' + rows['Date'], 'locationExcerpt': 'Location  | ' + rows['Location'],
                        'sourceCapturedAt': int(captured.timestamp() * 1000), 'sourceRetrievedAt': int(retrieved.timestamp() * 1000),
                        'sourceModifiedAt': int(modified.timestamp() * 1000), 'sourcePublishedAt': None, 'reviewedAt': None,
                        'license': 'CC-BY-SA-4.0', 'attribution': content['title'] + ' — Wikipedia contributors; ' + source_url}}


def notify_event(url, event, packet=None, allow_local=False):
    """Send minimal status only to an explicitly configured receiver; never email/source bodies."""
    u = urlsplit(url)
    local = allow_local and u.scheme == 'http' and u.hostname in ('127.0.0.1', 'localhost')
    if (u.scheme != 'https' and not local) or not u.hostname or u.username or u.password or u.fragment:
        raise ValueError('Explicit HTTPS notification destination required')
    if event not in ('review-ready', 'reader-failed'): raise ValueError('Unknown notification event')
    notice = {'event': event, 'owner_approved': False, 'published': False}
    if packet:
        c = packet['context']
        if not c['sourceUrl'].startswith('https://en.wikipedia.org/wiki/'): raise ValueError('Public source required')
        notice.update(packet_id=c['packetHash'], source_url=c['sourceUrl'], source_revision=c['revision'])
    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs): return None
    body = json.dumps(notice).encode()
    if len(body) > 1200: raise ValueError('Notification exceeds bound')
    request = Request(url, data=body, headers={'Content-Type': 'application/json'}, method='POST')
    with build_opener(NoRedirect()).open(request, timeout=8) as response:
        if response.status not in (200, 201, 202, 204): raise ValueError('Notification not accepted')
    return notice


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--title', default='2026_Erste_Bank_Open')
    p.add_argument('--notify-url')
    p.add_argument('--test-local-notify', action='store_true')
    a = p.parse_args()
    try:
        packet = read_calendar(a.title)
    except Exception:
        if a.notify_url: notify_event(a.notify_url, 'reader-failed', allow_local=a.test_local_notify)
        raise SystemExit('Reader failed; no packet, review or publication produced.')
    print(json.dumps(packet, ensure_ascii=False, indent=2))
    if a.notify_url: notify_event(a.notify_url, 'review-ready', packet, a.test_local_notify)
