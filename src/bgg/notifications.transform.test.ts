// ============================================================
// notifications.transform.test.ts — unit tests for transformNotices()
// ============================================================
//
// Standalone (no test framework). Run:
//   npx tsx src/bgg/notifications.transform.test.ts
// Exits non-zero and prints the failing assertion on regression.
//
// The fixture below uses the REAL notice shapes captured from the live feed on
// 2026-06-07 (one of each item type), so the test reflects ground truth for the
// grouping/mapping logic.

import assert from 'node:assert/strict';
import { transformNotices, type NoticeFeed } from './notifications';

// One real notice of each observed item type, plus a SECOND article in the same
// thread as one of them (3614520) so we can prove grouping + multi-id collection.
const feed: NoticeFeed = {
  notices: [
    // brand-new thread (item == group): no distinct reply id to collect
    { triggers: [{ type: 'thing', id: '343526' }], linkItem: { type: 'thread', id: '3720323' }, trackingItem: { type: 'thread', id: '3720323' }, item: { type: 'thread', id: '3720323' }, group: { type: 'thread', id: '3720323' }, date: '2026-06-07T17:13:19+00:00', eventid: 97479111 },
    // two replies in the SAME thread 3614520 → one subscription, two notifiedItemIds
    { triggers: [{ type: 'thread', id: '3614520' }], linkItem: { type: 'article', id: '47780628' }, trackingItem: { type: 'thread', id: '3614520' }, item: { type: 'article', id: '47780628' }, group: { type: 'thread', id: '3614520' }, date: '2026-06-07T17:25:54+00:00', eventid: 97478000 },
    { triggers: [{ type: 'thread', id: '3614520' }], linkItem: { type: 'article', id: '47770000' }, trackingItem: { type: 'thread', id: '3614520' }, item: { type: 'article', id: '47770000' }, group: { type: 'thread', id: '3614520' }, date: '2026-06-07T09:00:00+00:00', eventid: 97470000 },
    // geeklist new item (group = geeklist, trackingItem = listitem)
    { triggers: [{ type: 'geeklist', id: '171669' }], linkItem: { type: 'listitem', id: '6233310' }, trackingItem: { type: 'listitem', id: '6233310' }, item: { type: 'listitem', id: '6233310' }, group: { type: 'geeklist', id: '171669' }, date: '2026-06-07T01:32:25+00:00', eventid: 97452765 },
    // blog post (stand-alone stub)
    { triggers: [{ type: 'thing', id: '436217' }], linkItem: { type: 'blogpost', id: '187181' }, trackingItem: { type: 'blogpost', id: '187181' }, item: { type: 'blogpost', id: '187181' }, group: { type: 'blogpost', id: '187181' }, date: '2026-06-06T20:46:39+00:00', eventid: 97400000 },
    // video (unknown stub type)
    { triggers: [{ type: 'thing', id: '436217' }], linkItem: { type: 'video', id: '615021' }, trackingItem: { type: 'video', id: '615021' }, item: { type: 'video', id: '615021' }, group: { type: 'video', id: '615021' }, date: '2026-06-07T17:33:47+00:00', eventid: 97480000 },
    // comment on a geeklist (essentialItem missing → fallback title)
    { triggers: [{ type: 'geeklist', id: '337500' }], linkItem: { type: 'comment', id: '13549758' }, trackingItem: { type: 'geeklist', id: '337500' }, item: { type: 'comment', id: '13549758' }, group: { type: 'geeklist', id: '337500' }, date: '2026-06-07T02:55:33+00:00', eventid: 97455000 },
  ],
  essentialItems: [
    { type: 'thread', id: '3720323', name: 'Defuse and the catapult from Raise the FLAGG', href: '/thread/3720323/defuse-and-the-catapult-from-raise-the-flagg', label: 'Thread', breadcrumbs: [{ name: 'G.I. JOE Deck-Building Game', href: '/x' }, { name: 'Rules', href: '/y' }] },
    { type: 'article', id: '47780628', name: 'Re: authentication thread', href: '/thread/3614520/article/47780628#47780628', label: 'Reply', breadcrumbs: [{ name: "Extended Stats: Friendless' Play Statistics", href: '/z' }] },
    { type: 'listitem', id: '6233310', name: 'Item for GeekList "1 Player Guild Trading Post"', href: '/geeklist/171669/1-player-guild-trading-post?itemid=6233310#6233310', label: 'GeekList Item', breadcrumbs: [{ name: 'Buy And Sell', href: '/b' }] },
    { type: 'blogpost', id: '187181', name: 'May 2026 Summary', href: '/blog/16913/blogpost/187181/may-2026-summary', label: 'Blog Post', breadcrumbs: [{ name: 'Games Played Summaries', href: '/g' }] },
    { type: 'video', id: '615021', name: 'The Lord of the Rings: Fate of the Fellowship - Insert', href: '/video/615021/lotr/insert', label: 'Video', breadcrumbs: [{ name: 'The Lord of the Rings: Fate of the Fellowship', href: '/v' }] },
  ],
};

const { subscriptions, clearItems } = transformNotices(feed);
const byId = (id: number) => subscriptions.find((s) => s.id === id);

// --- grouping: 7 notices collapse into 6 subscriptions (the two articles merge)
assert.equal(subscriptions.length, 6, `expected 6 subs, got ${subscriptions.length}`);

// --- thread with two replies: both ids collected, sorted ascending, unique
const t = byId(3614520);
assert.ok(t, 'thread 3614520 subscription missing');
assert.equal(t.type, 'thread');
assert.deepEqual(t.notifiedItemIds, [47770000, 47780628], 'article ids not collected/sorted');
assert.equal(t.unreadCount, 2, 'unreadCount should equal notice count');
// earliest date wins for the lookback window
assert.equal(t.notificationDate?.toISOString(), new Date('2026-06-07T09:00:00+00:00').toISOString());
assert.equal(t.parentName, "Extended Stats: Friendless' Play Statistics", 'parentName from breadcrumbs[0]');

// --- brand-new thread: item == group, so NO notifiedItemIds
const nt = byId(3720323);
assert.ok(nt, 'thread 3720323 missing');
assert.deepEqual(nt.notifiedItemIds, [], 'new-thread should have no distinct reply ids');
assert.equal(nt.parentName, 'G.I. JOE Deck-Building Game');
assert.equal(nt.url, 'https://boardgamegeek.com/thread/3720323/defuse-and-the-catapult-from-raise-the-flagg');

// --- geeklist: group=geeklist, listitem id collected, type mapped
const gl = byId(171669);
assert.ok(gl, 'geeklist 171669 missing');
assert.equal(gl.type, 'geeklist');
assert.deepEqual(gl.notifiedItemIds, [6233310], 'listitem id should be collected');

// --- type mapping for stubs
assert.equal(byId(187181)?.type, 'blog', 'blogpost → blog');
assert.equal(byId(615021)?.type, 'unknown', 'video → unknown stub');

// --- comment on geeklist with NO essentialItem → fallback title, geeklist type
const cm = byId(337500);
assert.ok(cm, 'geeklist 337500 (comment) missing');
assert.equal(cm.type, 'geeklist');
assert.equal(cm.title, 'Geeklist 337500', 'fallback title when essentialItem missing');
assert.equal(cm.url, 'https://boardgamegeek.com/geeklist/337500', 'canonical url fallback');

// --- clear list: deduped trackingItems. Note article trackingItem is the THREAD
//     (3614520 once, not twice), and the geeklist-item trackingItem is the LISTITEM.
const clearKeys = clearItems.map((c) => `${c.type}:${c.id}`).sort();
assert.deepEqual(
  clearKeys,
  ['blogpost:187181', 'geeklist:337500', 'listitem:6233310', 'thread:3614520', 'thread:3720323', 'video:615021'].sort(),
  `clear list wrong: ${clearKeys.join(', ')}`,
);

console.log('✓ notifications.transform.test.ts — all assertions passed');
