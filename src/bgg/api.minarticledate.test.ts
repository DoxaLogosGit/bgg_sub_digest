// ============================================================
// api.minarticledate.test.ts — the timezone of BGG's date filter
// ============================================================
//
// Standalone test (the project has no test framework). Run it with:
//   npx tsx src/bgg/api.minarticledate.test.ts
//
// WHAT IT GUARDS (observed 2026-09-03, against the live API):
//
//   `minarticledate` carries no UTC offset and BGG reads it in the ACCOUNT'S
//   LOCAL timezone. We were formatting it from toISOString() — UTC — so for
//   an account at -05:00 every cutoff landed FIVE HOURS IN THE FUTURE and the
//   API returned nothing. The caller's 2h buffer could not absorb that, so
//   real activity came back as "no fetchable new articles" and the pipeline
//   wrote a "content not retrievable" stub instead.
//
//   Measured on thread 3761626 (the run had sent "2026-09-02 12:12:31"):
//       no minarticledate     -> 26 articles (newest 11:07:10-05:00)
//       the value we sent     ->  0 articles
//       that value minus 4h   ->  2 articles   <- exactly the 2 unread
//
//   11 of 34 subscriptions were emptied this way on the 2026-09-03 run. All
//   11 returned real content when re-fetched. After the fix, all 11 recover,
//   and an 802-article thread returns just its 2 new posts.
//
//   The fix widens only what we SEND. index.ts still re-filters client-side
//   against the precise cutoff using parsed Date objects, so over-fetching
//   costs nothing in correctness.

import assert from 'node:assert/strict';
import { bggMinArticleDateParam } from './api';

// The largest negative UTC offset actually in use (Baker Island, -12:00).
// If BGG reads our string in a zone at least this far behind UTC, the widened
// value must STILL be at or before the true cutoff.
const WORST_NEGATIVE_OFFSET_HOURS = 12;

// ---- 1. BGG's accepted format: "YYYY-MM-DD HH:mm:ss" ----
// Verified empirically in api.ts: an ISO-8601 "T" separator returns 400.
{
  const out = bggMinArticleDateParam(new Date('2026-09-02T12:12:31.000Z'));

  assert.match(out, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, `bad format: ${out}`);
  assert.ok(!out.includes('T'), 'a "T" separator returns 400 from BGG');
  assert.ok(!out.includes('Z'), 'BGG rejects a trailing Z');
}

// ---- 2. the real 2026-09-03 regression ----
// The run sent "2026-09-02 12:12:31" and got nothing back, because BGG read
// it as 12:12:31 at -05:00 = 17:12:31Z, later than both unread posts
// (14:12:31Z and 16:07:10Z). The new value, read the same way, must fall at
// or before the true cutoff so those posts are returned.
{
  const trueCutoff = new Date('2026-09-02T12:12:31.000Z');
  const sent = bggMinArticleDateParam(trueCutoff);

  // Read our string back the way a -05:00 account's BGG does.
  const asReadByBgg = new Date(sent.replace(' ', 'T') + '-05:00');

  assert.ok(
    asReadByBgg.getTime() <= trueCutoff.getTime(),
    `cutoff must not land after the true cutoff — sent ${sent}, read as ${asReadByBgg.toISOString()}`,
  );

  // The two articles the run should have seen must now be inside the window.
  for (const post of ['2026-09-02T14:12:31.000Z', '2026-09-02T16:07:10.000Z']) {
    assert.ok(
      new Date(post).getTime() >= asReadByBgg.getTime(),
      `${post} was the unread activity and must be inside the window`,
    );
  }
}

// ---- 3. safe for ANY timezone BGG might use, not just this account's ----
// Today the account reads -05:00 (CDT). In November it is -06:00, and a
// different account could be anywhere. The margin must cover the extreme.
{
  const trueCutoff = new Date('2026-09-02T12:12:31.000Z');
  const sent = bggMinArticleDateParam(trueCutoff);
  const naive = new Date(sent.replace(' ', 'T') + 'Z').getTime();

  for (let offset = -WORST_NEGATIVE_OFFSET_HOURS; offset <= 14; offset++) {
    // BGG reading our naive string in a zone `offset` hours from UTC yields
    // this absolute instant.
    const asRead = naive - offset * 3600 * 1000;
    assert.ok(
      asRead <= trueCutoff.getTime(),
      `offset ${offset}h would put the cutoff after the true one`,
    );
  }
}

// ---- 4. the widening is backwards, never forwards ----
// A cutoff later than what the caller asked for is the whole bug; assert the
// direction explicitly so nobody "tidies" the sign.
{
  const cutoff = new Date('2026-09-02T12:12:31.000Z');
  const sent = new Date(bggMinArticleDateParam(cutoff).replace(' ', 'T') + 'Z');

  assert.ok(sent.getTime() < cutoff.getTime(), 'must widen backwards');
  assert.ok(
    cutoff.getTime() - sent.getTime() >= WORST_NEGATIVE_OFFSET_HOURS * 3600 * 1000,
    'margin must cover the worst negative UTC offset',
  );
}

// ---- 5. date arithmetic crosses day and month boundaries ----
// The value is built by slicing an ISO string, so an off-by-one in the
// widening would silently produce a malformed or wrong-day cutoff.
{
  const justAfterMidnight = bggMinArticleDateParam(new Date('2026-09-01T02:00:00.000Z'));
  assert.equal(justAfterMidnight, '2026-08-31 12:00:00', 'must roll back into the previous month');

  const newYear = bggMinArticleDateParam(new Date('2027-01-01T05:00:00.000Z'));
  assert.equal(newYear, '2026-12-31 15:00:00', 'must roll back across the year boundary');
}

console.log('✓ api.minarticledate.test.ts — all assertions passed');
