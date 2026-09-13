// ============================================================
// local/highlights.test.ts — the cross-subscription block, cheaply
// ============================================================
//
// Standalone. Run: npx tsx src/local/highlights.test.ts

import assert from 'node:assert/strict';
import { summaryLines, mechanicalHighlights } from './highlights';
import type { ManifestEntry } from '../agent';
import type { InterestsConfig } from '../interests';

const cfg: InterestsConfig = {
  priorityTitles: ['SGOYT'], trackedGames: ['Spirit Island'], keywords: ['solo'], notes: '',
};

function entry(over: Partial<ManifestEntry> & { title: string }): ManifestEntry {
  return {
    subscriptionId: 1, type: 'thread', url: 'https://boardgamegeek.com/thread/1',
    filePath: '/tmp/x.md', itemCount: 1, unreadCount: 1, notificationDate: null, ...over,
  };
}

// ---- summaryLines extracts only what the synthesis pass needs ----
//
// Feeding 46 full sections (~31KB) back to a 9B model recreates exactly the
// overwhelm this whole design avoids. The Summary lines are a fraction of
// that and are what a highlights block is built from anyway.
{
  const sections = [
    '### [A](https://x/1)\n\n**Summary:** First thing happened in detail.\n\n**New Activity:**\n- a — x\n\n**Topics Mentioned:** solo',
    '### [B](https://x/2)\n\n**Summary:** Second thing happened in detail.\n\n**New Activity:**\n- b — y\n\n**Topics Mentioned:** none',
  ].join('\n\n');

  const out = summaryLines(sections);
  assert.match(out, /A — First thing happened in detail\./);
  assert.match(out, /B — Second thing happened in detail\./);
  assert.ok(!out.includes('- a — x'), 'bullets are excluded');
  assert.match(out, /First thing happened in detail\. \(from a\)/,
    'but their authors are kept — without them Highlights wrote "Community member" (2026-09-13)');
  assert.ok(out.length < sections.length / 2, 'the result is substantially smaller');
}

// ---- a bracketed title survives ----
//
// Real BGG titles open with a bracket: "[Detective Hawk] Wayfarers ...".
{
  const s = '### [[Detective Hawk] Wayfarers of the South Tigris](https://x/3)\n\n**Summary:** A deal was posted.';
  assert.match(summaryLines(s), /Detective Hawk/);
}

// ---- mechanicalHighlights needs no model at all ----
{
  const entries = [
    entry({ title: 'SGOYT September', selfActivity: { reasons: ['1 comment on your item "Tarawa 1943"'], replyCount: 1 } }),
    entry({ title: 'Random thread', parentName: 'Spirit Island' }),
    entry({ title: 'Unrelated thread' }),
  ];
  const hl = mechanicalHighlights(entries, cfg);

  assert.ok(hl.startsWith('## ⭐ Highlights'), 'uses the exact header the post-processor looks for');
  assert.match(hl, /Replies to you.*Tarawa 1943/, 'replies to you lead');
  assert.match(hl, /SGOYT September/, 'priority subscriptions are named');
  assert.match(hl, /Spirit Island/, 'tracked games are named');
  assert.ok(!hl.includes('Unrelated thread'), 'ordinary subscriptions are not highlighted');
}

// ---- with nothing notable, it still produces a valid block ----
//
// A Highlights block with no bullets reads as a generation failure, and
// isMissingHighlights would treat the digest as defective.
{
  const hl = mechanicalHighlights([entry({ title: 'Unrelated thread' })], cfg);
  assert.ok(hl.startsWith('## ⭐ Highlights'));
  assert.match(hl, /^- /m, 'always at least one bullet');
}

// ---- image uploads never appear in Highlights ----
//
// Highlights is what the reader sees first. 32 image notices on a tracked game
// would otherwise own that bullet, burying the discussion the game is tracked
// FOR. They still get their own grouped section at the bottom.
{
  const entries = [
    entry({ title: 'Custom Models', url: 'https://boardgamegeek.com/image/1/x', parentName: 'Spirit Island' }),
    entry({ title: 'Custom Models', url: 'https://boardgamegeek.com/image/2/x', parentName: 'Spirit Island' }),
    entry({ title: 'Rules question', parentName: 'Spirit Island' }),
  ];
  const hl = mechanicalHighlights(entries, cfg);
  const bullet = hl.split('\n').find((l) => l.includes('Spirit Island')) ?? '';
  assert.match(bullet, /Rules question/, 'real discussion is highlighted');
  assert.ok(!bullet.includes('Custom Models'), 'image uploads are not');
}

// ---- a game with ONLY image uploads earns no highlight at all ----
{
  const hl = mechanicalHighlights([
    entry({ title: 'Custom Models', url: 'https://boardgamegeek.com/image/1/x', parentName: 'Spirit Island' }),
  ], cfg);
  assert.ok(!hl.includes('Spirit Island'),
    'images alone are not a reason to highlight a tracked game');
}

// ---- a game with 30 identical entries is COUNTED, not enumerated ----
//
// 2026-09-12: BGG emitted one notice per image, and the tracked-game bullet
// read "activity in Custom Models, Custom Models, Custom Models, ..." thirty
// times over. The reader's complaint was exactly this.
{
  const many = Array.from({ length: 30 }, () =>
    entry({ title: 'Custom Models', parentName: 'Spirit Island' }));
  const hl = mechanicalHighlights(many, cfg);

  const bullet = hl.split('\n').find((l) => l.includes('Spirit Island')) ?? '';
  assert.ok((bullet.match(/Custom Models/g) ?? []).length <= 1,
    `a repeated title must appear at most once, got: ${bullet.slice(0, 120)}`);
  assert.match(bullet, /30/, 'the count is reported instead');
  assert.ok(bullet.length < 200, `the bullet stays readable, was ${bullet.length} chars`);
}

// ---- a long list of DISTINCT titles is truncated with a count ----
{
  const many = Array.from({ length: 12 }, (_, i) =>
    entry({ title: `Thread number ${i}`, parentName: 'Spirit Island' }));
  const hl = mechanicalHighlights(many, cfg);
  const bullet = hl.split('\n').find((l) => l.includes('Spirit Island')) ?? '';
  assert.ok(bullet.length < 250, `long bullets are truncated, was ${bullet.length}`);
  assert.match(bullet, /more/, 'and say how many were not listed');
}

// ---- the block satisfies the pipeline's own guard ----
{
  const hl = mechanicalHighlights([entry({ title: 'SGOYT September' })], cfg);
  assert.match(hl, /^##[ \t]+⭐[ \t]+Highlights[ \t]*$/m,
    'matches the header liftHighlightsToTop and isMissingHighlights key on');
}

console.log('highlights.test.ts: all assertions passed ✓');
