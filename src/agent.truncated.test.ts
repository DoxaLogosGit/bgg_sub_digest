// ============================================================
// agent.truncated.test.ts — the "most subscriptions never rendered" guard
// ============================================================
//
// Standalone (no test framework). Run:
//   npx tsx src/agent.truncated.test.ts
//
// WHAT IT GUARDS (observed 2026-09-10, pi + nemotron-3-super:cloud, a
// 31-subscription night):
//
//   The model read all 31 subscriptions — its Highlights block named SGOYT,
//   Marvel Champions threads, PIFF 3.0 and the deals threads — but the digest
//   contained exactly ONE `### [` section. All three existing detectors passed
//   it: it was not a template echo, it HAD a Highlights block, and
//   isVacuousDigest never engages below 6 sections. So the run was stamped
//   'complete', emailed as [OK], and cleared 90 BGG notices. That activity is
//   unrecoverable.
//
//   The gap was structural: nothing compared what the model rendered against
//   how many subscriptions it was given. The manifest count was sitting at the
//   call site the whole time and simply was not passed in.

import assert from 'node:assert/strict';
import {
  isTruncatedDigest, isVacuousDigest, isTemplateEcho, isMissingHighlights,
  generateGuardedDigest,
} from './agent';
import type { DigestResult } from './agent';

function sections(n: number, from = 0): string {
  let out = '';
  for (let i = from; i < from + n; i++) {
    out += `### [Subscription ${i}](https://boardgamegeek.com/thread/${1000 + i})\n\n`;
    out += `**Summary:** Real discussion about scenario ${i} and its difficulty.\n\n`;
    out += `**New Activity:**\n- ⭐ user${i} posted a session report.\n\n`;
    out += `**Topics Mentioned:** solo\n\n`;
  }
  return out;
}
const HL = '## ⭐ Highlights\n\n- ⭐ Spirit Island — a rules question.\n\n';

// ---- 1. THE 09-10 REGRESSION: 1 section rendered, 31 handed over ----
{
  const body = HL + sections(1);

  assert.equal(isTruncatedDigest(body, 31), true,
    '1 of 31 subscriptions rendered must be caught');

  // Precisely why it got through: every other detector is blind to this shape.
  assert.equal(isTemplateEcho(body), false,      'not a template echo');
  assert.equal(isMissingHighlights(body), false, 'Highlights block is present');
  assert.equal(isVacuousDigest(body), false,     'too few sections for the vacuous ratio to engage');
}

// ---- 2. a complete digest is not truncated ----
{
  const body = HL + sections(31);
  assert.equal(isTruncatedDigest(body, 31), false, '31 of 31 is complete');
}

// ---- 3. the small real-world shortfalls must NOT fire ----
//
// Calibrated against actual runs: 2026-09-01 rendered 33 of 35, 08-24 6 of 7,
// 08-26 5 of 6. Those digests were fine and were shipped; the guard must not
// start rejecting them and blocking notice-clearing every night.
{
  assert.equal(isTruncatedDigest(HL + sections(33), 35), false, '09-01: 33/35 must pass');
  assert.equal(isTruncatedDigest(HL + sections(6), 7),   false, '08-24: 6/7 must pass');
  assert.equal(isTruncatedDigest(HL + sections(5), 6),   false, '08-26: 5/6 must pass');
}

// ---- 4. the boundary ----
{
  // 60% coverage is the threshold: at or above it we ship.
  assert.equal(isTruncatedDigest(HL + sections(6), 10), false, '6/10 = 60% ships');
  assert.equal(isTruncatedDigest(HL + sections(5), 10), true,  '5/10 = 50% is truncated');
}

// ---- 5. bracketed titles must still count as sections ----
//
// A real title: "### [[Detective Hawk] Wayfarers of the South Tigris $23.40]".
// An earlier section-counting regex in this project captured `[^\]]+` and
// mis-parsed exactly this shape, so pin it.
{
  const body = HL +
    '### [[Detective Hawk] Wayfarers of the South Tigris $23.40](https://boardgamegeek.com/thread/1)\n\n' +
    '**Summary:** A deal was posted.\n\n**Topics Mentioned:** none\n\n' +
    '### [[GameNerdz DotD] Labyrinth $125.97](https://boardgamegeek.com/thread/2)\n\n' +
    '**Summary:** Another deal.\n\n**Topics Mentioned:** none\n\n';
  assert.equal(isTruncatedDigest(body, 2), false,
    'bracketed titles must count as rendered sections');
}

// ---- 6. an unknown expected count disables the guard ----
{
  assert.equal(isTruncatedDigest(HL + sections(1), 0), false,
    'no manifest count means no opinion — never block on a guess');
}

function result(body: string): DigestResult {
  return { body, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 };
}

async function retryPolicyTests() {
  // ---- 7. a truncated digest retries ONCE, then is marked invalid ----
  //
  // Retry (unlike the vacuous guard, which skips it) because this failure is
  // demonstrably NOT deterministic: re-running the exact 09-10 workspace
  // produced 31 sections rather than 1 — a different degenerate shape from the
  // same input. A retry has a real chance of landing a shippable digest.
  {
    let runs = 0;
    const out = await generateGuardedDigest(async () => {
      runs += 1;
      return result(HL + sections(1));
    }, 31);

    assert.equal(runs, 2, 'truncation must buy exactly one retry');
    assert.equal(out.status, 'invalid',
      'still truncated after the retry must be invalid so notices are NOT cleared');
  }

  // ---- 8. a retry that renders everything is shipped ----
  {
    let runs = 0;
    const out = await generateGuardedDigest(async () => {
      runs += 1;
      return result(runs === 1 ? HL + sections(1) : HL + sections(31));
    }, 31);

    assert.equal(runs, 2);
    assert.equal(out.status, undefined, 'a recovered digest stays shippable');
  }

  // ---- 9. a healthy digest runs once and is untouched ----
  {
    let runs = 0;
    const out = await generateGuardedDigest(async () => { runs += 1; return result(HL + sections(31)); }, 31);
    assert.equal(runs, 1);
    assert.equal(out.status, undefined);
  }

  console.log('✓ agent.truncated.test.ts — retry policy assertions passed');
}

console.log('agent.truncated.test.ts: detector assertions passed ✓');
retryPolicyTests().catch((err) => { console.error(err); process.exit(1); });
