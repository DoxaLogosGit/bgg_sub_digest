// ============================================================
// local/split.test.ts — cutting a subscription under the input cap
// ============================================================
//
// Standalone (no test framework). Run:
//   npx tsx src/local/split.test.ts
//
// WHAT THIS GUARDS (measured 2026-09-11): the local model returns SILENT
// EMPTY OUTPUT above roughly 3K input tokens. The 61KB / 50-item SGOYT
// geeklist produced zero characters and no error; 10 items produced all 10
// bullets in 24s. So the input has to be cut — and cut on record boundaries,
// because half a post is worse than no post.

import assert from 'node:assert/strict';
import { splitSubscriptionContent } from './split';

const header = '=== Geeklist: Solitaire Games on Your Table ===\n\n';
const item = (n: number) =>
  `[Item by member${n} posted 9/1/2026] — Game ${n}\nLink: https://x/#item${n}\n${'body '.repeat(40)}\n\n`;
const geeklist = header + [1, 2, 3, 4, 5, 6].map(item).join('');

// ---- under the cap: one part, returned unchanged ----
{
  const parts = splitSubscriptionContent(geeklist, 100_000);
  assert.equal(parts.length, 1, 'content under the cap is not split');
  assert.equal(parts[0], geeklist, 'and is returned byte-for-byte');
}

// ---- over the cap: split on item boundaries ----
{
  const parts = splitSubscriptionContent(geeklist, 700);
  assert.ok(parts.length > 1, 'content over the cap is split');
  const all = parts.join('');
  for (const n of [1, 2, 3, 4, 5, 6]) {
    assert.equal((all.match(new RegExp(`\\[Item by member${n} `, 'g')) ?? []).length, 1,
      `item ${n} appears exactly once across the parts`);
  }
}

// ---- the file header is repeated into every part ----
//
// Each part becomes its own model call with no memory of the others. A part
// that does not say which geeklist it is gets summarised without that context.
{
  const parts = splitSubscriptionContent(geeklist, 700);
  for (const p of parts) {
    assert.ok(p.startsWith('=== Geeklist: Solitaire Games on Your Table ==='),
      'every part carries the file header');
  }
}

// ---- threads split on "[Post by ...]" ----
{
  const thread = '=== Thread: Best solo game ===\n\n' +
    [1, 2, 3, 4].map((n) =>
      `[Post by user${n} on 9/1/2026]\nLink: https://x?article=${n}\n${'text '.repeat(40)}\n\n`).join('');
  const parts = splitSubscriptionContent(thread, 600);
  assert.ok(parts.length > 1, 'threads split too');
  const all = parts.join('');
  for (const n of [1, 2, 3, 4]) {
    assert.equal((all.match(new RegExp(`\\[Post by user${n} `, 'g')) ?? []).length, 1,
      `post ${n} appears exactly once`);
  }
}

// ---- a single record larger than the cap is NOT truncated ----
//
// Losing content silently is the failure this pipeline keeps relearning. An
// oversized record goes out whole and over cap; the model may do badly with
// it, and the section guard catches that.
{
  const huge = header + `[Item by whale posted 9/1/2026] — Big\n${'x'.repeat(5000)}\n\n`;
  const parts = splitSubscriptionContent(huge, 500);
  assert.equal(parts.length, 1, 'an oversized single record stays one part');
  assert.ok(parts[0].includes('x'.repeat(5000)), 'and is never truncated');
}

// ---- content with no markers is returned whole ----
{
  const stub = 'New activity on a BGG blog you subscribe to.\nLink: https://x\n';
  assert.deepEqual(splitSubscriptionContent(stub, 10), [stub],
    'a stub with no record markers cannot be split and is passed through');
}

// ---- empty input ----
assert.deepEqual(splitSubscriptionContent('', 100), [], 'empty content yields no parts');

// ---- no part is empty ----
{
  for (const cap of [200, 700, 3000]) {
    for (const p of splitSubscriptionContent(geeklist, cap)) {
      assert.ok(p.trim().length > 0, `cap=${cap}: an empty part would spawn a pointless model call`);
    }
  }
}

console.log('split.test.ts: all assertions passed ✓');
