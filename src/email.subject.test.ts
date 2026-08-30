// ============================================================
// email.subject.test.ts — status tag in the email subject
// ============================================================
//
// Standalone test (the project has no test framework yet). Run it with:
//   npx tsx src/email.subject.test.ts
//
// WHAT IT GUARDS (2026-08-30, observed for real):
//   Four digests were emailed on one day. The 3am cron run failed (ollama
//   returned 402) and sent:
//       "[GENERATION FAILED] BGG Digest — Sunday, August 30, 2026"
//   The three later runs all SUCCEEDED and sent the untagged:
//       "BGG Digest — Sunday, August 30, 2026"
//
//   buildEmailSubject() encodes only the DATE, so every run in a day shares a
//   base subject. Gmail collapses same-subject mail into one conversation and
//   displays the FIRST message's subject, so a perfectly good digest sat under
//   a "GENERATION FAILED" heading for the rest of the day.
//
//   Tagging success explicitly gives successes and failures DIFFERENT subject
//   lines, so a failed run can no longer head a thread of good ones.

import assert from 'node:assert/strict';
import { buildEmailSubject, statusSubjectPrefix } from './email';

// ---- 1. success is tagged, not bare ----
// The whole point: a successful run must NOT produce the untagged subject that
// let it get absorbed into the failed run's thread.
{
  assert.equal(statusSubjectPrefix('complete'), '[OK] ');
  assert.notEqual(statusSubjectPrefix('complete'), '', 'success must carry a tag');
}

// ---- 2. failure states keep their existing tags ----
{
  assert.equal(statusSubjectPrefix('invalid'), '[GENERATION FAILED] ');
  assert.equal(statusSubjectPrefix('error'), '[GENERATION FAILED] ');
  assert.equal(statusSubjectPrefix('rate_limited'), '[RATE LIMITED] ');
  assert.equal(statusSubjectPrefix('partial'), '[PARTIAL] ');
}

// ---- 3. a non-empty skipped list means PARTIAL even when status says complete ----
// index.ts treats `skipped.length > 0` as partial regardless of status; the
// helper must agree or the banner and the subject would disagree.
{
  assert.equal(statusSubjectPrefix('complete', 3), '[PARTIAL] ');
}

// ---- 4. hard failures outrank a skipped list ----
// Ordering guard: an 'error' run with skipped entries must read as a failure,
// not as a partial success.
{
  assert.equal(statusSubjectPrefix('error', 5), '[GENERATION FAILED] ');
  assert.equal(statusSubjectPrefix('invalid', 5), '[GENERATION FAILED] ');
}

// ---- 5. success and failure subjects actually differ ----
// The real regression, expressed end-to-end: same date, different outcome =>
// different subject line, so they cannot thread together.
{
  const date = new Date('2026-08-30T08:00:00Z');
  const good = statusSubjectPrefix('complete') + buildEmailSubject(date);
  const bad  = statusSubjectPrefix('error') + buildEmailSubject(date);

  assert.notEqual(good, bad, 'a good and a failed run on the same day must differ');
  assert.ok(good.startsWith('[OK] BGG Digest'), `unexpected good subject: ${good}`);
  assert.ok(bad.startsWith('[GENERATION FAILED] BGG Digest'), `unexpected bad subject: ${bad}`);
}

// ---- 6. the date portion is unchanged ----
// Guard against accidentally reformatting the subject while adding the tag.
{
  const date = new Date('2026-08-30T12:00:00Z');
  assert.ok(
    buildEmailSubject(date).startsWith('BGG Digest — '),
    'base subject format must be untouched',
  );
}

console.log('✓ email.subject.test.ts — all assertions passed');
