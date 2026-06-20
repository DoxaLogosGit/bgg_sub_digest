// ============================================================
// geeklist-selection.test.ts — unit tests for itemsWithActivityNewerThan()
// ============================================================
//
// Standalone (no test framework). Run:
//   npx tsx src/bgg/geeklist-selection.test.ts
// Exits non-zero and prints the failing assertion on regression.
//
// REGRESSION GUARDED: on an established ranking geeklist, the real activity is
// new COMMENTS on existing items, but BGG's v1 API does NOT bump an item's
// editdate when a comment is posted. The old postdate/editdate filter therefore
// saw zero new items and the pipeline dumped arbitrary stale entries instead of
// the one item that was actually commented on. This fixture mirrors that exact
// shape (drawn from geeklist 366471, "2025 People's Choice Top Solo Games"):
// an old item that got a fresh comment must be selected; old quiet items must
// not be.

import assert from 'node:assert/strict';
import { itemsWithActivityNewerThan } from './api';
import type { BggGeeklistItem } from '../types';

// The earliest unread notice was 2026-06-19T06:49:45Z; the pipeline subtracts a
// 2h buffer, so the cutoff handed to selection is 04:49:45Z.
const cutoff = new Date('2026-06-19T04:49:45Z');

function item(over: Partial<BggGeeklistItem> & { id: number }): BggGeeklistItem {
  return {
    username: 'kerskine',
    postdate: new Date('2025-11-20T09:24:49Z'),
    editdate: new Date('2025-11-20T09:24:49Z'),
    objectName: `Game ${over.id}`,
    objectId: over.id,
    body: '',
    link: `https://boardgamegeek.com/geeklist/366471#item${over.id}`,
    comments: [],
    ...over,
  };
}

const items: BggGeeklistItem[] = [
  // Quiet old item, no new comments — must be EXCLUDED (this is the noise the
  // old recentItems() fallback used to flood the digest with).
  item({ id: 1, objectName: 'Fallout' }),
  // Old item (postdate/editdate in Nov 2025, NOT bumped) but with a fresh
  // June-2026 comment — must be SELECTED. This is the case the old filter missed.
  item({
    id: 2,
    objectName: 'Dungeon Alliance',
    comments: [
      { username: 'a', date: new Date('2026-01-01T00:00:00Z'), body: 'old, already seen' },
      { username: 'b', date: new Date('2026-06-19T17:33:40Z'), body: 'fresh!' },
    ],
  }),
  // Old item whose only comment predates the cutoff — must be EXCLUDED.
  item({
    id: 3,
    objectName: 'Brass: Birmingham',
    comments: [{ username: 'c', date: new Date('2026-06-10T00:00:00Z'), body: 'stale' }],
  }),
  // Genuinely new item added after the cutoff (no comments) — must be SELECTED.
  item({ id: 4, objectName: 'Brand New Entry', postdate: new Date('2026-06-19T10:00:00Z') }),
  // Old item whose BODY was edited after the cutoff (editdate bumped, no new
  // comments) — must be SELECTED so we stay a strict superset of the old filter.
  item({ id: 5, objectName: 'Edited Entry', editdate: new Date('2026-06-19T12:00:00Z') }),
];

const selected = itemsWithActivityNewerThan(items, cutoff);
const ids = selected.map((i) => i.id);

// Commented-on item (2), genuinely-new item (4), and edited item (5) survive.
assert.deepEqual([...ids].sort((a, b) => a - b), [2, 4, 5],
  `expected items [2,4,5] selected, got [${ids}]`);

// Quiet/stale items are NOT selected (the core regression).
assert.ok(!ids.includes(1), 'quiet old item must not be selected');
assert.ok(!ids.includes(3), 'item with only pre-cutoff comments must not be selected');

// Newest-activity-first ordering by true last-activity: item 2's comment
// (June 19 17:33) > item 5's editdate (12:00) > item 4's postdate (10:00).
// Proves the sort accounts for comment dates AND editdate, matching the filter.
assert.deepEqual(ids, [2, 5, 4], `expected order [2,5,4] (activity-aware sort), got [${ids}]`);

// Empty result when nothing is newer than the cutoff (drives the stub path, not
// a recentItems() dump).
assert.equal(
  itemsWithActivityNewerThan(items, new Date('2026-06-20T00:00:00Z')).length,
  0,
  'no items should be selected when cutoff is after all activity',
);

console.log('geeklist-selection.test.ts: all assertions passed ✓');
