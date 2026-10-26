"""Deterministic daily completion assessment. No scheduler, database, network or publication writes."""
from datetime import datetime
from zoneinfo import ZoneInfo


def stamp(value):
    t = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if t.tzinfo is None: raise ValueError('Timezone-aware timestamp required')
    return t


def assess(now, deadline, runs, expected_day, timezone='America/New_York'):
    now, deadline = stamp(now), stamp(deadline)
    if now < deadline:
        return {'state': 'not_due', 'alert': False, 'key': None}
    valid = []
    for run in runs:
        receipt = run.get('staging_receipt')
        if not receipt or receipt.get('published') is not False or receipt.get('owner_approved') is not False or not receipt.get('id'):
            continue
        when = stamp(receipt['acknowledged_at'])
        if when > now: continue
        if when.astimezone(ZoneInfo(timezone)).date().isoformat() != expected_day: continue
        if run.get('conclusion') == 'success' and run.get('staging_step') == 'success': valid.append(run)
    if valid:
        return {'state': 'healthy', 'alert': False, 'key': None}
    state = 'missed' if not runs else 'failed' if any(r.get('conclusion') == 'failure' for r in runs) else 'skipped' if any(r.get('conclusion') == 'skipped' or r.get('staging_step') == 'skipped' for r in runs) else 'incomplete'
    return {'state': state, 'alert': True, 'key': 'tennismoon-daily:' + expected_day,
            'reason': 'No successful durable staging acknowledgement for the expected local day. Do not advance verification or publish.'}
