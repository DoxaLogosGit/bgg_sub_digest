// ============================================================
// agent.vacuous.test.ts — the "structurally perfect, says nothing" guard
// ============================================================
//
// Standalone test (the project has no test framework). Run it with:
//   npx tsx src/agent.vacuous.test.ts
//
// WHAT IT GUARDS (observed 2026-09-01, 09-02, 09-03 with pi +
// nemotron-3-super:cloud, three mornings running):
//
//   The model emitted a digest with the right number of `### [Title](url)`
//   sections, the right field labels, and a real `## ⭐ Highlights` header —
//   but every section was invented boilerplate rather than anything read out
//   of the subscription data files. isTemplateEcho() missed it (the model
//   wrote fresh filler instead of copying the template's angle-bracket
//   examples) and isMissingHighlights() missed it (the header was present),
//   so the run was stamped 'complete', mailed as [OK], and 60 BGG notices
//   were cleared — losing that day's activity.
//
//   The fixtures below are trimmed from the actual digests on disk.

import assert from 'node:assert/strict';
import { isVacuousDigest, isTemplateEcho, isMissingHighlights } from './agent';

// Build N sections from a (summary, bullet) generator — real digests are
// dozens of sections long and the guard is a ratio, so shape matters.
function digest(n: number, gen: (i: number) => { summary: string; bullets: string[] }): string {
  let out = '## ⭐ Highlights\n\n- ⭐ Spirit Island — a rules question in two threads.\n\n';
  for (let i = 0; i < n; i++) {
    const { summary, bullets } = gen(i);
    out += `### [Subscription ${i}](https://boardgamegeek.com/thread/${1000 + i})\n\n`;
    out += `**Summary:** ${summary}\n\n**New Activity:**\n`;
    out += bullets.map((b) => `- ${b}`).join('\n');
    out += `\n\n**Topics Mentioned:** none\n\n`;
  }
  return out;
}

// ---- 1. the 2026-09-03 shape: identical summary AND identical bullet ----
// 34 sections, 2 distinct summaries, 2 distinct bullet lists.
{
  const body = digest(34, (i) => (i % 3 === 0
    ? { summary: 'New replies posted, but content not retrievable due to API limits.',
        bullets: ['Content not retrievable (stub)'] }
    : { summary: 'New activity detected in this subscription.',
        bullets: ['See subscription details for new posts.'] }));

  assert.equal(isVacuousDigest(body), true, '09-03 shape must be caught');
  // The point of the new guard: neither existing detector sees this.
  assert.equal(isTemplateEcho(body), false, 'not a template echo');
  assert.equal(isMissingHighlights(body), false, 'Highlights block is present');
}

// ---- 2. the 2026-09-01 shape: UNIQUE summaries, identical bullets ----
// Every section said "New activity in <its own title>." — so the summary
// ratio is a perfect 1.00 and only the bullet ratio catches it. This is why
// the two signals are OR'd rather than AND'd.
{
  const body = digest(33, (i) => ({
    summary: `New activity in Subscription ${i}.`,
    bullets: ['See the discussion at the link for details.'],
  }));

  assert.equal(isVacuousDigest(body), true, '09-01 shape must be caught');
}

// ---- 3. the 2026-09-02 shape: identical summaries, VARIED bullets ----
// The mirror image of #2: real per-post bullets, but 20 sections sharing the
// literal unfilled "One new post discusses ..." summary. Only the summary
// ratio catches this one.
{
  const body = digest(34, (i) => ({
    summary: 'One new post discusses ...',
    bullets: [`**user${i}**: said something specific about game ${i} []`],
  }));

  assert.equal(isVacuousDigest(body), true, '09-02 shape must be caught');
}

// ---- 4. a good digest is not flagged ----
// The 2026-08-31 shape: every section describes different activity.
{
  const body = digest(14, (i) => ({
    summary: `Discussion about game ${i}, with users weighing setup and difficulty.`,
    bullets: [
      `⭐ user${i} explained the search roll only triggers with Nazgul present: https://boardgamegeek.com/thread/${1000 + i}?article=${48119512 + i}`,
      `player${i} replied that they have not been that lucky yet.`,
    ],
  }));

  assert.equal(isVacuousDigest(body), false, 'a real digest must pass');
}

// ---- 5. stub-heavy days survive ----
// Subscriptions whose replies fall outside BGG's API window legitimately
// render as near-identical "not retrievable" sections. 2026-08-31 had 5 such
// duplicates out of 14 sections and was a GOOD digest — the thresholds must
// clear it, or the guard costs the user a real digest.
{
  const body = digest(14, (i) => (i < 5
    ? { summary: 'New replies detected but content not retrievable.',
        bullets: ['No retrievable content.'] }
    : { summary: `Users discussed the ${i}th scenario and its difficulty curve.`,
        bullets: [`⭐ user${i} posted a session report scoring ${200 + i} points.`] }));

  assert.equal(isVacuousDigest(body), false, '5 stubs of 14 is a normal day');
}

// ---- 6. light days are exempt ----
// Below MIN_SECTIONS a single duplicate pair is a large fraction of the
// digest and means nothing. A 4-section day of pure stubs must not trip.
{
  const body = digest(4, () => ({
    summary: 'New replies detected but content not retrievable.',
    bullets: ['No retrievable content.'],
  }));

  assert.equal(isVacuousDigest(body), false, 'too few sections to judge');
}

// ---- 7. no sections at all is not this guard's business ----
// An empty or preamble-only body is isMissingHighlights()'s call, not ours.
{
  assert.equal(isVacuousDigest(''), false);
  assert.equal(isVacuousDigest('## ⭐ Highlights\n\n- ⭐ Something happened.\n'), false);
}

// ---- 8. summary-label bolding drifts between runs ----
// 08-31 wrote bare "Summary:", 09-03 wrote "**Summary:**". Which one the
// model picks is not a defect, so the guard must read both the same way.
{
  const bold  = digest(10, () => ({ summary: 'Nothing to report.', bullets: ['See link.'] }));
  const plain = bold.replace(/\*\*Summary:\*\*/g, 'Summary:');

  assert.equal(isVacuousDigest(bold), true);
  assert.equal(isVacuousDigest(plain), true, 'unbolded Summary: must read the same');
}

console.log('✓ agent.vacuous.test.ts — all assertions passed');

// ============================================================
// generateGuardedDigest — retry policy
// ============================================================
//
// Verified 2026-09-03 by re-running the exact 09-03 workspace: the vacuous
// failure is DETERMINISTIC at 34 subscriptions (a fourth run produced the same
// 2-distinct-summary shape). A retry there costs another 9-17 minutes at 3am
// and lands in the same place, so this defect alone skips it. The other two
// defects were each seen once and keep the retry.

import { generateGuardedDigest, type DigestResult } from './agent';

function result(body: string): DigestResult {
  return { body, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 };
}

const vacuousBody = digest(34, () => ({
  summary: 'Activity detected.',
  bullets: ['Activity detected.'],
}));
const goodBody = digest(14, (i) => ({
  summary: `Users discussed scenario ${i} and its difficulty curve.`,
  bullets: [`⭐ user${i} posted a session report scoring ${200 + i} points.`],
}));

// Wrapped in a function: tsx compiles these standalone tests to CJS, which
// has no top-level await.
async function retryPolicyTests() {
  // ---- 9. a vacuous digest is marked invalid WITHOUT a second run ----
  {
    let runs = 0;
    const out = await generateGuardedDigest(async () => { runs += 1; return result(vacuousBody); });

    assert.equal(runs, 1, 'vacuous must not burn a retry — the failure is deterministic');
    assert.equal(out.status, 'invalid', 'vacuous must be invalid so notices are NOT cleared');
  }

  // ---- 10. a missing-Highlights digest still gets its retry ----
  // Unchanged behavior: that defect has no evidence of being deterministic,
  // and a retry that succeeds saves the whole day's digest.
  {
    let runs = 0;
    const out = await generateGuardedDigest(async () => {
      runs += 1;
      return result(runs === 1 ? goodBody.replace('## ⭐ Highlights', '## Notes') : goodBody);
    });

    assert.equal(runs, 2, 'missing Highlights must still retry once');
    assert.equal(out.status, undefined, 'a successful retry stays shippable');
  }

  // ---- 11. a good digest runs exactly once ----
  {
    let runs = 0;
    const out = await generateGuardedDigest(async () => { runs += 1; return result(goodBody); });

    assert.equal(runs, 1);
    assert.equal(out.status, undefined);
  }

  console.log('✓ agent.vacuous.test.ts — retry policy assertions passed');
}

retryPolicyTests().catch((err) => { console.error(err); process.exit(1); });
