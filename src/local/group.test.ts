// ============================================================
// local/group.test.ts — collapse near-duplicate subscriptions
// ============================================================
//
// Standalone. Run: npx tsx src/local/group.test.ts
//
// WHAT THIS GUARDS (2026-09-12): BGG's notice feed emits ONE NOTICE PER IMAGE.
// A single game picking up 30 image uploads arrived as 30 "subscriptions",
// all titled "Custom Models", all with the same parent, each with its own
// image/NNNNNNN url. Rendered one-per-section that is 30 near-identical
// blocks — the reader's words: "it repeats a lot".

import assert from 'node:assert/strict';
import { groupDuplicateEntries } from './group';
import type { ManifestEntry } from '../agent';

function entry(over: Partial<ManifestEntry> & { title: string; url: string }): ManifestEntry {
  return {
    subscriptionId: Math.floor(Math.random() * 1e6),
    type: 'unknown', filePath: '/tmp/x.md',
    itemCount: 1, unreadCount: 1, notificationDate: null, ...over,
  };
}

const stub = (n: number) => entry({
  title: 'Custom Models',
  url: `https://boardgamegeek.com/image/97975${n}/lotr`,
  parentName: 'The Lord of the Rings: Fate of the Fellowship',
});

// ---- identical title+parent+type collapse into ONE group ----
{
  const entries = [stub(1), stub(2), stub(3)];
  const groups = groupDuplicateEntries(entries, () => true);
  assert.equal(groups.length, 1, '30 images of one game are one group, not 30');
  assert.equal(groups[0].length, 3, 'and the group keeps every member');
}

// ---- distinct subscriptions are NOT merged ----
{
  const entries = [
    entry({ title: 'Best solo game', url: 'https://x/1', type: 'thread' }),
    entry({ title: 'SGOYT September', url: 'https://x/2', type: 'geeklist' }),
    stub(1),
  ];
  const groups = groupDuplicateEntries(entries, () => true);
  assert.equal(groups.length, 3, 'different subscriptions stay separate');
}

// ---- same title but a DIFFERENT parent stays separate ----
//
// "Custom Models" on two different games is two different things.
{
  const groups = groupDuplicateEntries([
    stub(1),
    entry({ title: 'Custom Models', url: 'https://x/9', parentName: 'Spirit Island' }),
  ], () => true);
  assert.equal(groups.length, 2);
}

// ---- only groupable when the predicate says so ----
//
// Grouping is for STUBS — entries with no fetchable content. Merging two real
// threads that happen to share a title would merge their content, which is a
// different and worse bug.
{
  const groups = groupDuplicateEntries([stub(1), stub(2)], () => false);
  assert.equal(groups.length, 2, 'non-groupable entries are never merged');
}

// ---- a mix: only the groupable duplicates collapse ----
{
  const real = entry({ title: 'Custom Models', url: 'https://x/real', parentName: 'The Lord of the Rings: Fate of the Fellowship' });
  const groups = groupDuplicateEntries(
    [stub(1), real, stub(2)],
    (e) => e.url.includes('/image/'),
  );
  // stub(1) and stub(2) group; `real` shares their key but is not groupable.
  assert.equal(groups.length, 2, 'the ungroupable entry keeps its own section');
  assert.ok(groups.some((g) => g.length === 2), 'the two stubs merged');
  assert.ok(groups.some((g) => g.length === 1 && g[0].url === 'https://x/real'));
}

// ---- order is preserved by first appearance ----
{
  const a = entry({ title: 'A', url: 'https://x/a', type: 'thread' });
  const b = entry({ title: 'B', url: 'https://x/b', type: 'thread' });
  const groups = groupDuplicateEntries([a, stub(1), b, stub(2)], () => true);
  assert.deepEqual(groups.map((g) => g[0].title), ['A', 'Custom Models', 'B'],
    'groups appear where their first member did, so ranking survives');
}

// ---- nothing is lost ----
{
  const entries = [stub(1), stub(2), stub(3), entry({ title: 'A', url: 'https://x/a' })];
  const groups = groupDuplicateEntries(entries, () => true);
  assert.equal(groups.flat().length, entries.length, 'every entry is in exactly one group');
}

// ---- empty input ----
assert.deepEqual(groupDuplicateEntries([], () => true), []);

console.log('group.test.ts: all assertions passed ✓');
