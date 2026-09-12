// ============================================================
// local/validate.test.ts — is this section's PROSE worth shipping?
// ============================================================
//
// Standalone. Run: npx tsx src/local/validate.test.ts
//
// WHY THIS GUARD EXISTS: isTruncatedDigest counts "### [" headers to catch a
// digest that rendered almost nothing — the 2026-09-10 failure that shipped 1
// section of 31 as 'complete' and cleared 90 BGG notices. On the local path
// CODE writes those headers, so they are always present and that guard goes
// blind. Without a prose-level check the same failure returns in a new
// costume: structurally perfect, says nothing.

import assert from 'node:assert/strict';
import { sectionDefect } from './validate';

const good = [
  '### [Best solo train game?](https://boardgamegeek.com/thread/1)',
  '',
  '**Summary:** Members debated engine-building trains and recommended three titles.',
  '',
  '**New Activity:**',
  '- alice — recommends Irish Gauge for its tight auction.',
  '- bob — argues Age of Steam is still the benchmark.',
  '',
  '**Topics Mentioned:** solo',
].join('\n');

assert.equal(sectionDefect(good), null, 'a complete section has no defect');

// ---- missing Summary ----
{
  const d = sectionDefect(good.replace(/\*\*Summary:\*\*.*/, ''));
  assert.ok(d && /summary/i.test(d), `missing Summary must be a defect, got ${d}`);
}

// ---- empty Summary ----
{
  const d = sectionDefect(good.replace(/\*\*Summary:\*\*.*/, '**Summary:**'));
  assert.ok(d && /summary/i.test(d), 'an empty Summary is a defect');
}

// ---- a Summary too short to carry information ----
{
  const d = sectionDefect(good.replace(/\*\*Summary:\*\*.*/, '**Summary:** New activity.'));
  assert.ok(d && /summary/i.test(d), 'a stub Summary is a defect');
}

// ---- no bullets ----
{
  const d = sectionDefect(good.replace(/^- .*$/gm, ''));
  assert.ok(d && /bullet/i.test(d), `zero bullets must be a defect, got ${d}`);
}

// ---- empty body ----
assert.ok(sectionDefect(''), 'an empty section is a defect');

// ---- the "See file for details" shape from 2026-09-10 ----
//
// The re-run of that workspace produced 31 sections, every one of which read
// "**Summary:** See file for details." That must not pass.
{
  const vacuous = good
    .replace(/\*\*Summary:\*\*.*/, '**Summary:** See file for details.')
    .replace(/^- .*$/gm, '- See file for details');
  assert.ok(sectionDefect(vacuous), 'the "See file for details" shape is a defect');
}

// ---- a real but TERSE section still passes ----
//
// This is a floor against emptiness, not a quality score. Rejecting honest
// short summaries would send good content round the retry/split/skip ladder.
{
  const terse = [
    '### [Trade thread](https://boardgamegeek.com/thread/2)',
    '',
    '**Summary:** A single want-to-buy post for Spirit Island, with no replies yet.',
    '',
    '**New Activity:**',
    '- carol — wants to buy Spirit Island.',
    '',
    '**Topics Mentioned:** none',
  ].join('\n');
  assert.equal(sectionDefect(terse), null, 'a terse but real section ships');
}

// ---- a bullet that is only filler does not count as a bullet ----
{
  const fillerBullets = good.replace(/^- .*$/gm, '- Activity detected');
  assert.ok(sectionDefect(fillerBullets), 'filler bullets do not satisfy the bullet requirement');
}

console.log('validate.test.ts: all assertions passed ✓');
