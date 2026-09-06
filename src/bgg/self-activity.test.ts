// ============================================================
// self-activity.test.ts — unit tests for the "replies to you" detector
// ============================================================
//
// Standalone (no test framework). Run:
//   npx tsx src/bgg/self-activity.test.ts
// Exits non-zero and prints the failing assertion on regression.
//
// WHAT THIS GUARDS: the digest is supposed to float replies aimed at the
// reader to the top. The precision requirement is the whole point — the
// reader explicitly chose STRICT thread matching, because the loose reading
// ("any thread I ever posted in") promotes every busy monthly thread he
// dropped one comment into. The "What's on your table" case below is that
// exact scenario and it must NOT be flagged.

import assert from 'node:assert/strict';
import { detectThreadSelfActivity, detectGeeklistSelfActivity } from './self-activity';
import type { BggThreadArticle, BggGeeklistItem, BggGeeklistComment } from '../types';

const ME = 'DoxaLogos';

// ---- fixture helpers -------------------------------------------

let nextArticleId = 1000;
function article(over: Partial<BggThreadArticle> = {}): BggThreadArticle {
  const id = over.id ?? nextArticleId++;
  return {
    id,
    username: 'someone_else',
    postdate: new Date('2026-09-05T12:00:00Z'),
    editdate: new Date('2026-09-05T12:00:00Z'),
    subject: '',
    body: 'A perfectly ordinary post.',
    link: `https://boardgamegeek.com/thread/1?article=${id}`,
    ...over,
  };
}

function comment(over: Partial<BggGeeklistComment> = {}): BggGeeklistComment {
  return {
    username: 'someone_else',
    date: new Date('2026-09-05T12:00:00Z'),
    body: 'Nice pick.',
    ...over,
  };
}

function item(over: Partial<BggGeeklistItem> & { id: number }): BggGeeklistItem {
  return {
    username: 'list_regular',
    postdate: new Date('2026-08-01T09:00:00Z'),
    editdate: new Date('2026-08-01T09:00:00Z'),
    objectName: `Game ${over.id}`,
    objectId: over.id,
    body: '',
    link: `https://boardgamegeek.com/geeklist/1#item${over.id}`,
    comments: [],
    ...over,
  };
}

// The digest cutoff: anything at or before this was already read.
const cutoff = new Date('2026-09-05T00:00:00Z');
const OLD    = new Date('2026-08-20T09:00:00Z');   // before the cutoff
const NEW    = new Date('2026-09-05T12:00:00Z');   // after the cutoff
const NEWER  = new Date('2026-09-05T18:00:00Z');   // after NEW

// ============================================================
// THREADS
// ============================================================

// ---- R1: a thread you started, replied to by others ----
{
  const found = detectThreadSelfActivity({
    me: ME,
    threadStarter: ME,
    newArticles: [article({ username: 'alice' }), article({ username: 'bob' })],
  });
  assert.ok(found, 'replies in a thread you started must be flagged');
  assert.equal(found.replyCount, 2, 'both replies count');
  assert.match(found.reasons.join(' '), /thread you started/i);
}

// A thread you started where the only new post is your own is NOT a reply.
{
  const found = detectThreadSelfActivity({
    me: ME,
    threadStarter: ME,
    newArticles: [article({ username: ME })],
  });
  assert.equal(found, null, 'your own follow-up post is not a reply to you');
}

// ---- R2: someone quoted you ----
{
  const found = detectThreadSelfActivity({
    me: ME,
    threadStarter: 'trekkienz',
    newArticles: [
      article({ username: 'alice', body: 'DoxaLogos wrote:\nI think the limit applies.\n\nAgreed, that matches my read.' }),
      article({ username: 'bob' }),
    ],
  });
  assert.ok(found, 'a post quoting you must be flagged');
  assert.equal(found.replyCount, 1, 'only the quoting post counts, not the unrelated one');
  assert.match(found.reasons.join(' '), /quoting you/i);
}

// The quote must be at the start of a line — an incidental mention is not a quote.
{
  const found = detectThreadSelfActivity({
    me: ME,
    threadStarter: 'trekkienz',
    newArticles: [article({ username: 'alice', body: 'I agree with what DoxaLogos wrote: it is unclear.' })],
  });
  assert.equal(found, null, 'an inline mention is not a BGG quote block');
}

// Quoting YOURSELF is not a reply to you.
{
  const found = detectThreadSelfActivity({
    me: ME,
    threadStarter: 'trekkienz',
    newArticles: [article({ username: ME, body: 'DoxaLogos wrote:\nearlier me\n\nfollowing up' })],
  });
  assert.equal(found, null, 'self-quote is not a reply to you');
}

// ---- THE STRICT-MODE REGRESSION ----
// "What's on your table" — you posted in it once, 40 unrelated posts followed.
// Strict matching must leave this alone; loose matching would promote it nightly.
{
  const found = detectThreadSelfActivity({
    me: ME,
    threadStarter: 'weekly_host',
    newArticles: [
      article({ username: ME, postdate: OLD }),
      article({ username: 'alice' }),
      article({ username: 'bob' }),
      article({ username: 'carol' }),
    ],
  });
  assert.equal(found, null,
    'STRICT MODE: merely having posted in a busy thread must NOT flag it');
}

// ---- Case-insensitivity: BGG usernames are not case-stable in quotes ----
{
  const found = detectThreadSelfActivity({
    me: ME,
    threadStarter: 'doxalogos',
    newArticles: [article({ username: 'alice' })],
  });
  assert.ok(found, 'thread starter match must be case-insensitive');
}
{
  const found = detectThreadSelfActivity({
    me: ME,
    threadStarter: 'trekkienz',
    newArticles: [article({ username: 'alice', body: 'doxalogos wrote:\nquoted\n\nreply' })],
  });
  assert.ok(found, 'quote match must be case-insensitive');
}

// ---- Unknown starter (the count=1 fetch failed) degrades to quote-only ----
{
  const found = detectThreadSelfActivity({
    me: ME,
    threadStarter: null,
    newArticles: [article({ username: 'alice' })],
  });
  assert.equal(found, null, 'unknown starter must not be assumed to be you');
}

// ---- Both rules firing on one thread: no double counting ----
{
  const quoting = article({ username: 'alice', body: 'DoxaLogos wrote:\nq\n\nreply' });
  const found = detectThreadSelfActivity({
    me: ME,
    threadStarter: ME,
    newArticles: [quoting, article({ username: 'bob' })],
  });
  assert.ok(found);
  assert.equal(found.replyCount, 2,
    'the quoting post must be counted once, not once per matching rule');
  assert.equal(found.reasons.length, 2, 'both reasons are reported');
}

// ============================================================
// GEEKLISTS
// ============================================================

// ---- R5: new comments on an item you contributed ----
{
  const found = detectGeeklistSelfActivity({
    me: ME,
    geeklistOwner: 'kerskine',
    items: [
      item({ id: 1, username: ME, comments: [comment({ date: NEW }), comment({ username: 'bob', date: NEW })] }),
      item({ id: 2, comments: [comment({ date: NEW })] }),
    ],
    cutoff,
  });
  assert.ok(found, 'comments on your own geeklist item must be flagged');
  assert.equal(found.replyCount, 2, 'both new comments on your item count');
  assert.match(found.reasons.join(' '), /your item/i);
  assert.match(found.reasons.join(' '), /Game 1/, 'the reason names the item');
}

// Old comments on your item are already-read — they do not re-flag it.
{
  const found = detectGeeklistSelfActivity({
    me: ME,
    geeklistOwner: 'kerskine',
    items: [item({ id: 1, username: ME, comments: [comment({ date: OLD })] })],
    cutoff,
  });
  assert.equal(found, null, 'pre-cutoff comments are already read');
}

// Your own comment on your own item is not a reply to you.
{
  const found = detectGeeklistSelfActivity({
    me: ME,
    geeklistOwner: 'kerskine',
    items: [item({ id: 1, username: ME, comments: [comment({ username: ME, date: NEW })] })],
    cutoff,
  });
  assert.equal(found, null, 'your own comment is not a reply to you');
}

// ---- R6: someone commented after you, on someone else's item ----
{
  const found = detectGeeklistSelfActivity({
    me: ME,
    geeklistOwner: 'kerskine',
    items: [
      item({ id: 1, comments: [
        comment({ username: ME, date: OLD }),
        comment({ username: 'alice', date: NEW }),
      ] }),
    ],
    cutoff,
  });
  assert.ok(found, 'a new comment following yours must be flagged');
  assert.equal(found.replyCount, 1);
  assert.match(found.reasons.join(' '), /your comment/i);
}

// A new comment posted BEFORE yours is not a reply to you.
{
  const found = detectGeeklistSelfActivity({
    me: ME,
    geeklistOwner: 'kerskine',
    items: [
      item({ id: 1, comments: [
        comment({ username: 'alice', date: NEW }),
        comment({ username: ME, date: NEWER }),
      ] }),
    ],
    cutoff,
  });
  assert.equal(found, null, 'a comment that predates yours is not a reply to it');
}

// An item you never touched, with new comments, is ordinary activity.
{
  const found = detectGeeklistSelfActivity({
    me: ME,
    geeklistOwner: 'kerskine',
    items: [item({ id: 1, comments: [comment({ username: 'alice', date: NEW })] })],
    cutoff,
  });
  assert.equal(found, null, 'unrelated new comments must not be flagged');
}

// ---- R4: activity on a geeklist you own ----
{
  const found = detectGeeklistSelfActivity({
    me: ME,
    geeklistOwner: ME,
    items: [
      item({ id: 1, username: 'alice', postdate: NEW, editdate: NEW }),
      item({ id: 2, comments: [comment({ username: 'bob', date: NEW })] }),
    ],
    cutoff,
  });
  assert.ok(found, 'activity on your own geeklist must be flagged');
  assert.equal(found.replyCount, 2, 'one new item + one new comment');
  assert.match(found.reasons.join(' '), /your geeklist/i);
}

// Your own geeklist with only your own activity is not a reply.
{
  const found = detectGeeklistSelfActivity({
    me: ME,
    geeklistOwner: ME,
    items: [item({ id: 1, username: ME, postdate: NEW, editdate: NEW })],
    cutoff,
  });
  assert.equal(found, null, 'your own item on your own list is not a reply to you');
}

// Owning the list AND authoring the item: the comment is counted once.
{
  const found = detectGeeklistSelfActivity({
    me: ME,
    geeklistOwner: ME,
    items: [item({ id: 1, username: ME, comments: [comment({ username: 'alice', date: NEW })] })],
    cutoff,
  });
  assert.ok(found);
  assert.equal(found.replyCount, 1,
    'one comment matching two rules must be counted once');
}

// ---- Case-insensitive owner/author/commenter matching ----
{
  const found = detectGeeklistSelfActivity({
    me: ME,
    geeklistOwner: 'kerskine',
    items: [item({ id: 1, username: 'doxalogos', comments: [comment({ username: 'alice', date: NEW })] })],
    cutoff,
  });
  assert.ok(found, 'item author match must be case-insensitive');
}

// ---- Null cutoff (unparseable notification date): everything counts as new ----
{
  const found = detectGeeklistSelfActivity({
    me: ME,
    geeklistOwner: 'kerskine',
    items: [item({ id: 1, username: ME, comments: [comment({ username: 'alice', date: OLD })] })],
    cutoff: null,
  });
  assert.ok(found, 'with no cutoff we cannot tell old from new — flag it');
}

// ---- Empty inputs are safe ----
assert.equal(detectThreadSelfActivity({ me: ME, threadStarter: null, newArticles: [] }), null);
assert.equal(detectGeeklistSelfActivity({ me: ME, geeklistOwner: 'x', items: [], cutoff }), null);
assert.equal(
  detectThreadSelfActivity({ me: '', threadStarter: '', newArticles: [article({ username: 'alice' })] }),
  null,
  'an empty configured username must never match',
);

console.log('self-activity.test.ts: all assertions passed ✓');
