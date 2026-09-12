// ============================================================
// interests.test.ts — priority ordering and chunk splitting
// ============================================================
//
// Standalone (no test framework). Run:
//   npx tsx src/interests.test.ts
//
// WHY ORDERING MOVED INTO CODE (2026-09-10): the digest now summarises
// subscriptions in chunks, because nemotron-3-super degenerates when handed
// ~30 at once — six healthy runs at <=21 subscriptions, four degenerate runs
// at >=31. A chunk only sees its own subscriptions, so "put the priority ones
// first" cannot be a judgement the model makes: nothing inside a chunk knows
// what is in the others. Rank the whole set here, THEN split.

import assert from 'node:assert/strict';
import { rankEntries, chunkEntries, renderInterestsMarkdown, isImageUpload } from './interests';
import type { ManifestEntry, InterestsConfig } from './interests';

const cfg: InterestsConfig = {
  priorityTitles: ['SGOYT', "Dave's", 'Dad Jokes'],
  trackedGames:   ['Star Trek: Captain\'s Chair', 'Marvel Champions'],
  keywords:       ['solo'],
  notes:          'Auction geeklists matter too.',
};

function e(over: Partial<ManifestEntry> & { title: string }): ManifestEntry {
  return {
    subscriptionId: Math.floor(Math.random() * 100000),
    type: 'thread',
    url: 'https://boardgamegeek.com/thread/1',
    filePath: '/tmp/x.md',
    itemCount: 1,
    unreadCount: 1,
    notificationDate: null,
    ...over,
  } as ManifestEntry;
}

// ---- 1. replies to you outrank everything, including priority titles ----
{
  const ranked = rankEntries([
    e({ title: 'SGOYT September 2026' }),
    e({ title: 'Some random thread', selfActivity: { reasons: ['2 replies in a thread you started'], replyCount: 2 } }),
  ], cfg);

  assert.equal(ranked[0].title, 'Some random thread',
    'a direct reply to the reader outranks even a priority subscription');
  assert.equal(ranked[1].title, 'SGOYT September 2026');
}

// ---- 2. priority titles beat tracked games, which beat parented, which beat the rest ----
{
  const ranked = rankEntries([
    e({ title: 'Unrelated orphan thread' }),
    e({ title: 'Some thread', parentName: 'Wingspan' }),
    e({ title: 'A wave 3 question', parentName: "Star Trek: Captain's Chair" }),
    e({ title: 'SGOYT September 2026' }),
  ], cfg);

  assert.deepEqual(ranked.map((r) => r.title), [
    'SGOYT September 2026',
    'A wave 3 question',
    'Some thread',
    'Unrelated orphan thread',
  ], 'tiers must sort: priority title > tracked game > has parent > everything else');
}

// ---- 3. title matching is case-insensitive and substring-based ----
{
  const ranked = rankEntries([
    e({ title: 'Nothing special' }),
    e({ title: "dave's game shelf update" }),   // lowercase, mid-string
  ], cfg);
  assert.equal(ranked[0].title, "dave's game shelf update",
    'priority matching must be case-insensitive substring matching');
}

// ---- 4. ranking is STABLE within a tier ----
//
// Two subscriptions in the same tier must keep their feed order. Without this
// the digest reshuffles nightly for no reason and diffs become unreadable.
{
  const input = [
    e({ title: 'SGOYT September 2026' }),
    e({ title: 'SGOYT August 2026' }),
    e({ title: "Dave's picks" }),
  ];
  const ranked = rankEntries(input, cfg);
  assert.deepEqual(ranked.map((r) => r.title),
    ['SGOYT September 2026', 'SGOYT August 2026', "Dave's picks"],
    'equal-tier entries keep their original order');
}

// ---- 4b. image uploads rank LAST, even on a tracked game ----
//
// 2026-09-12: BGG emits one notice per image. A tracked game that gained 32
// images put all 32 in TIER_TRACKED_GAME — above every ordinary subscription —
// so the digest opened with an image flood. An upload notice carries no
// content to read; it belongs at the bottom whatever it is attached to.
{
  const ranked = rankEntries([
    e({ title: 'Custom Models', url: 'https://boardgamegeek.com/image/9797585/lotr',
        parentName: "Star Trek: Captain's Chair" }),
    e({ title: 'Unrelated orphan thread' }),
    e({ title: 'A wave 3 question', parentName: "Star Trek: Captain's Chair" }),
  ], cfg);

  assert.equal(ranked[ranked.length - 1].title, 'Custom Models',
    'an image upload sorts below even an unrelated orphan thread');
  assert.equal(ranked[0].title, 'A wave 3 question',
    'and the real tracked-game discussion keeps its place');
}

// ---- 4c. a reply to YOU still outranks the image rule ----
{
  const ranked = rankEntries([
    e({ title: 'Ordinary thread' }),
    e({ title: 'Custom Models', url: 'https://boardgamegeek.com/image/1/x',
        selfActivity: { reasons: ['1 comment on your image'], replyCount: 1 } }),
  ], cfg);
  assert.equal(ranked[0].title, 'Custom Models',
    'somebody responding to the reader outranks the de-emphasis');
}

// ---- 4d. isImageUpload recognises the notice shape, and only that ----
//
// The rule keys on BGG's /image/<id>/ url. Anything else — a thread, a
// geeklist, a file page — is real content and must never be dropped.
{
  assert.equal(isImageUpload({ url: 'https://boardgamegeek.com/image/9797585/lotr' }), true);
  assert.equal(isImageUpload({ url: 'https://boardgamegeek.com/thread/3765831/best-train' }), false);
  assert.equal(isImageUpload({ url: 'https://boardgamegeek.com/geeklist/383712' }), false);
  assert.equal(isImageUpload({ url: 'https://boardgamegeek.com/filepage/328738/gi-joe' }), false);
  assert.equal(isImageUpload({ url: 'https://boardgamegeek.com/blog/2414/blogpost/190813' }), false);

  // A thread that merely mentions the word is not an image notice.
  assert.equal(isImageUpload({ url: 'https://boardgamegeek.com/thread/1/image-quality-question' }), false,
    'the pattern requires /image/<digits>, not the word anywhere in a slug');
}

// ---- 5. chunking preserves the ranked order across chunk boundaries ----
{
  const ranked = rankEntries(
    Array.from({ length: 31 }, (_, i) => e({ title: i === 30 ? 'SGOYT September' : `Thread ${i}` })),
    cfg,
  );
  const chunks = chunkEntries(ranked, 12);

  assert.equal(chunks.length, 3, '31 entries at size 12 makes 3 chunks');
  assert.deepEqual(chunks.map((c) => c.length), [12, 12, 7]);
  assert.equal(chunks[0][0].title, 'SGOYT September',
    'the highest-ranked entry must be first in the FIRST chunk');

  // Flattening the chunks must reproduce the ranking exactly — no entry
  // dropped, duplicated, or reordered by the split.
  assert.deepEqual(
    chunks.flat().map((c) => c.title),
    ranked.map((r) => r.title),
    'chunking must be a pure partition of the ranked list',
  );
}

// ---- 6. no entry is ever lost or duplicated ----
{
  for (const n of [0, 1, 11, 12, 13, 24, 31]) {
    const ranked = rankEntries(Array.from({ length: n }, (_, i) => e({ title: `T${i}` })), cfg);
    const chunks = chunkEntries(ranked, 12);
    const ids = chunks.flat().map((c) => c.title);
    assert.equal(ids.length, n, `n=${n}: every entry survives chunking`);
    assert.equal(new Set(ids).size, n, `n=${n}: no duplicates`);
    assert.ok(chunks.every((c) => c.length > 0), `n=${n}: no empty chunk is emitted`);
  }
}

// ---- 7. a chunk size at or above the entry count yields ONE chunk ----
//
// Small nights must keep behaving exactly as they always have: one model run,
// no synthesis pass, no behaviour change. This is what keeps the 6 healthy
// runs at <=21 subscriptions on their existing, proven path.
{
  const ranked = rankEntries(Array.from({ length: 8 }, (_, i) => e({ title: `T${i}` })), cfg);
  assert.equal(chunkEntries(ranked, 12).length, 1, '8 entries at size 12 is a single chunk');
}

// ---- 8. the rendered INTERESTS.md carries everything the model needs ----
{
  const md = renderInterestsMarkdown(cfg);
  assert.match(md, /SGOYT/,                       'priority titles reach the model');
  assert.match(md, /Star Trek: Captain's Chair/,  'tracked games reach the model');
  assert.match(md, /solo/,                        'keywords reach the model');
  assert.match(md, /Auction geeklists matter too/, 'free-text notes are passed verbatim');
}

console.log('interests.test.ts: all assertions passed ✓');
