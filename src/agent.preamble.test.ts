// ============================================================
// agent.preamble.test.ts — regression test for model-preamble stripping
// ============================================================
//
// Standalone test (the project has no test framework yet). Run it with:
//   npx tsx src/agent.preamble.test.ts
// It exits non-zero and prints the failing assertion if the pipeline
// regresses.
//
// WHAT IT GUARDS:
//   minimax-m3:cloud (observed in the 2026-06-04 cron run) ignores the
//   CLAUDE.md instruction to "begin directly with the first ### [Title]
//   header" and instead emits a block of planning narration ("Good, I've
//   scanned...", "### Plan", "Now writing the digest...") BEFORE the digest.
//   postProcessDigestBody() must strip that preamble while still lifting
//   the trailing Highlights block to the top and keeping every real
//   section intact.
//
// The fixture below mirrors the SHAPE of the model's raw one-shot output:
// preamble first, then the "### [..]" sections, then "## ⭐ Highlights"
// LAST (the order CLAUDE.md asks for; liftHighlightsToTop reorders it for
// the reader). The narration strings are taken verbatim from the real
// leaked 2026-06-04 digest so the test reflects ground truth.

import assert from 'node:assert/strict';
import { postProcessDigestBody } from './agent';

// Raw model output as it would arrive BEFORE post-processing: plan preamble,
// then real sections, then a trailing Highlights block.
const rawModelOutput = `Good, I've scanned the entire GMT P500 list. Tracked games found: Away Team (in the list), Firefight Tactical (in the list), Founders of Reyvick (set in the Away Team universe).

Now I have all the information I need. Let me build the digest.

### Plan

**Ordering (per CLAUDE.md):**
1. **Priority Subscriptions** (match INTERESTS.md "Priority Subscriptions" list)
2. **Tracked Games** (parentName matches tracked games)

Now writing the digest. The output is the entire response — no file writing.

### [1 Player Guild / SGOYT - 2026 Solitaire Goals](https://boardgamegeek.com/geeklist/370786)
**Summary:** A 1 Player Guild 2026 Solitaire Goals entry from Njps.

**Topics Mentioned:** solo, solitaire

### [Solitaire Games On Your Table — October 2023](https://boardgamegeek.com/geeklist/322797)
**Summary:** Old (2023) SGOYT Solotober post resurfaces with two recent comments.

**Topics Mentioned:** solo, solitaire

## ⭐ Highlights

- ⭐ Earthborne Rangers — three EBR storage threads plus a Kickstarter update.
- Major theme: crowdfunded storage solutions for LCG-style card games.`;

const out = postProcessDigestBody(rawModelOutput);

// 1. Highlights is lifted to the very top of the digest.
assert.match(
  out,
  /^##[ \t]+⭐[ \t]+Highlights/,
  'Highlights block should be lifted to the top of the output',
);

// 2. Every scrap of plan narration is gone.
assert.ok(!out.includes("Good, I've scanned"), 'scan narration should be stripped');
assert.ok(!out.includes('Let me build the digest'), 'plan lead-in should be stripped');
assert.ok(!out.includes('### Plan'), 'the "### Plan" sub-header block should be stripped');
assert.ok(!out.includes('Now writing the digest'), 'closing narration should be stripped');

// 3. Both real subscription sections survive untouched.
assert.ok(
  out.includes('### [1 Player Guild / SGOYT - 2026 Solitaire Goals]'),
  'first real section should be kept',
);
assert.ok(
  out.includes('### [Solitaire Games On Your Table — October 2023]'),
  'second real section should be kept',
);

// 4. Exactly the two real "### [" section headers remain — nothing dropped,
//    nothing duplicated by the dedup/lift stages.
const sectionCount = (out.match(/^###[ \t]+\[/gm) ?? []).length;
assert.equal(sectionCount, 2, 'exactly two section headers should remain');

// 5. A clean digest (no preamble) must pass through unchanged in substance —
//    the strip step must not eat legitimate leading content.
const cleanOutput = `### [Some Game](https://boardgamegeek.com/thread/1)
**Summary:** Already clean.

## ⭐ Highlights

- ⭐ Nothing to strip here.`;
const cleanOut = postProcessDigestBody(cleanOutput);
assert.match(cleanOut, /^##[ \t]+⭐[ \t]+Highlights/, 'clean output: Highlights still lifted');
assert.ok(cleanOut.includes('### [Some Game]'), 'clean output: section preserved');

console.log('✓ stripPreamble + post-process pipeline: all assertions passed');
