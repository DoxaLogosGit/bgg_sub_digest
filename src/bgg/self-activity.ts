// ============================================================
// bgg/self-activity.ts — detect activity aimed AT the reader
// ============================================================
//
// WHY THIS EXISTS: the digest treats every subscription the same, so a
// direct reply to the reader sinks to wherever its subscription happens to
// sort. These two pure functions find the subscriptions where somebody
// actually responded to *him*, so index.ts can flag them in the manifest and
// the agent can float them to the top.
//
// PRECISION IS THE POINT. BGG forum threads are flat — there is no reply
// pointer, so "a reply to my post" can only ever be inferred. The reader
// explicitly chose the STRICT reading: a thread counts only if he started it
// or somebody quoted him. The loose reading ("any thread I ever posted in")
// would promote every busy monthly thread he once dropped a comment into,
// every single night. Geeklists are different — comments there ARE attached
// to a specific item, so the attribution is real rather than inferred.
//
// PYTHON CONTEXT: both functions are pure — no I/O, no dates read from the
// clock, no mutation of their arguments. Everything they need is passed in.
// That is what makes them testable without a BGG session (see
// self-activity.test.ts).
//
// TIMING CONSTRAINT — these MUST run on the RAW fetched objects, before
// agent.ts's formatters touch them. Two independent reasons:
//
//   1. formatThreadContent() runs renderQuotesAsBlockquotes(), which rewrites
//      "DoxaLogos wrote:" into "> **DoxaLogos wrote:**". The quote signal
//      only exists in the raw article body.
//   2. formatGeeklistContent() drops every comment older than the cutoff —
//      but the reader's OWN earlier comment is exactly what the "reply to
//      your comment" rule needs, and it survives only on the raw
//      geeklist.items[].comments array.
// ============================================================

import type { BggThreadArticle, BggGeeklistItem } from '../types';

// ---- SelfActivity ----------------------------------------------
//
// What the detector returns when it finds something. `null` means "nothing
// here is aimed at the reader" — the overwhelmingly common case.
export interface SelfActivity {
  // Human-readable phrases rendered into the digest section, e.g.
  // ["3 replies in a thread you started", "1 post quoting you"].
  // Written for a reader, not for a parser.
  reasons: string[];

  // How many distinct new posts/comments qualify. DISTINCT is the operative
  // word: a post that matches two rules (someone quoted you in a thread you
  // started) counts once, never twice.
  replyCount: number;
}

// At most this many per-item geeklist reasons before we collapse the tail
// into "…and N more". Without a cap, a busy list the reader contributes to
// heavily would render a single 40-clause sentence.
const MAX_ITEM_REASONS = 3;

// ---- small helpers ---------------------------------------------

// BGG usernames are case-preserving but not case-stable — the same account
// appears as "DoxaLogos" in an article attribute and "doxalogos" inside a
// quote block. Compare folded, always.
function sameUser(a: string, b: string): boolean {
  // An empty configured username would otherwise match every empty author
  // field and flag the entire digest. Fail closed.
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

// English pluralisation, just enough for the phrases below.
// Python: f"{n} {word}{'' if n == 1 else 's'}"
function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

// ---- quotesUser -------------------------------------------------
//
// Does this raw article body open a BGG quote block attributed to `me`?
//
// BGG's XML API returns quoted replies as inline text: the quoted author's
// name, the literal word "wrote:", a newline, then the quoted content. After
// stripMarkup() preserves paragraph breaks, that pattern sits at the start of
// a line. This mirrors the detection in agent.ts's renderQuotesAsBlockquotes.
//
// The line-start anchor is what separates a real quote from an incidental
// mention: "I agree with what DoxaLogos wrote: it is unclear" is somebody
// talking ABOUT him mid-sentence, not quoting him, and must not match.
function quotesUser(body: string, me: string): boolean {
  if (!body || !me) return false;

  // Escape regex metacharacters — BGG usernames may contain '.', '+', '-'.
  // Python: re.escape(me)
  const escaped = me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // (?:^|\n)  — start of body or start of a line (no /m flag needed)
  // [ \t]*    — tolerate leading indentation
  // \s+       — BGG is inconsistent about the space before "wrote:"
  // /i        — case-insensitive, per sameUser's reasoning
  return new RegExp(`(?:^|\\n)[ \\t]*${escaped}\\s+wrote:`, 'i').test(body);
}

// ============================================================
// detectThreadSelfActivity — the STRICT thread rules
// ============================================================
//
// Fires when either is true of the new articles:
//
//   R1  the reader started the thread, and somebody else has posted in it
//   R2  a new post by somebody else quotes the reader
//
// Deliberately NOT a rule: "the reader posted somewhere in this thread".
// See the module header.
//
// `threadStarter` is the username on the thread's OPENING post, fetched
// separately (`fetchThreadStarter`) because the digest's article window
// almost never reaches back to article #1. `null` means that lookup failed
// — in which case we simply cannot evaluate R1, and must not guess.
//
// `newArticles` are the articles selected for the digest — i.e. the unread
// ones. Older posts are irrelevant: the reader has already seen them.
export function detectThreadSelfActivity(params: {
  me: string;
  threadStarter: string | null;
  newArticles: BggThreadArticle[];
}): SelfActivity | null {
  const { me, threadStarter, newArticles } = params;
  if (!me) return null;

  // Everything the reader wrote himself is excluded up front. His own posts
  // are never news to him, and a self-quote is not a reply.
  const byOthers = newArticles.filter((a) => !sameUser(a.username, me));
  if (byOthers.length === 0) return null;

  // Article ids that qualify under ANY rule. A Set because the two rules
  // overlap freely and replyCount must not double-count.
  const qualifying = new Set<number>();
  const reasons: string[] = [];

  // ---- R1: a thread the reader started ----
  if (threadStarter !== null && sameUser(threadStarter, me)) {
    for (const a of byOthers) qualifying.add(a.id);
    reasons.push(`${plural(byOthers.length, 'reply', 'replies')} in a thread you started`);
  }

  // ---- R2: somebody quoted the reader ----
  const quoting = byOthers.filter((a) => quotesUser(a.body, me));
  if (quoting.length > 0) {
    for (const a of quoting) qualifying.add(a.id);
    reasons.push(`${plural(quoting.length, 'post')} quoting you`);
  }

  if (qualifying.size === 0) return null;
  return { reasons, replyCount: qualifying.size };
}

// ============================================================
// detectGeeklistSelfActivity — the geeklist rules
// ============================================================
//
// Fires on any of:
//
//   R4  the reader owns the geeklist, and others added items or comments
//   R5  an item the reader contributed picked up comments from others
//   R6  somebody commented after the reader on somebody else's item
//
// Unlike threads these are real attributions, not inferences: a geeklist
// comment is attached to one specific item.
//
// `items` are the items selected for the digest, carrying their FULL comment
// lists (not the cutoff-filtered view the formatter renders). `cutoff` is the
// already-read boundary; `null` means the notification date was unparseable,
// in which case we cannot distinguish old from new and treat everything as
// new — over-flagging is the safe direction here, since the alternative is
// silently dropping a genuine reply.
export function detectGeeklistSelfActivity(params: {
  me: string;
  geeklistOwner: string;
  items: BggGeeklistItem[];
  cutoff: Date | null;
}): SelfActivity | null {
  const { me, geeklistOwner, items, cutoff } = params;
  if (!me) return null;

  const isNew = (d: Date): boolean => cutoff === null || d > cutoff;

  // Comments have no id in BGG's v1 API, so identity is composed from the
  // item plus author plus timestamp — unique in practice and, more to the
  // point, stable across the three rules so the union below dedupes.
  const qualifying = new Set<string>();
  const itemReasons: string[] = [];

  const ownsList = sameUser(geeklistOwner, me);
  let ownListItems = 0;      // new items added by others to the reader's list
  let ownListComments = 0;   // new comments left by others on the reader's list

  for (const item of items) {
    const itemIsMine = sameUser(item.username, me);

    const newCommentsByOthers = item.comments.filter(
      (c) => isNew(c.date) && !sameUser(c.username, me),
    );

    // ---- R4 accounting (only when the reader owns the list) ----
    if (ownsList) {
      if (!itemIsMine && isNew(item.postdate)) {
        qualifying.add(`item:${item.id}`);
        ownListItems += 1;
      }
      for (const c of newCommentsByOthers) {
        qualifying.add(`comment:${item.id}:${c.username}:${c.date.getTime()}`);
        ownListComments += 1;
      }
    }

    // ---- R5: comments on an item the reader contributed ----
    if (itemIsMine) {
      if (newCommentsByOthers.length > 0) {
        for (const c of newCommentsByOthers) {
          qualifying.add(`comment:${item.id}:${c.username}:${c.date.getTime()}`);
        }
        itemReasons.push(
          `${plural(newCommentsByOthers.length, 'comment')} on your item "${item.objectName}"`,
        );
      }
      // R5 and R6 are mutually exclusive per item: if the item is the
      // reader's, every comment on it is already covered above.
      continue;
    }

    // ---- R6: somebody replied after the reader on another member's item ----
    //
    // "After" is literal — a comment that predates the reader's own is not a
    // response to it. We anchor on his LATEST comment on this item, so only
    // genuinely subsequent discussion counts.
    const myComments = item.comments.filter((c) => sameUser(c.username, me));
    if (myComments.length === 0) continue;

    const myLatest = Math.max(...myComments.map((c) => c.date.getTime()));
    const after = newCommentsByOthers.filter((c) => c.date.getTime() > myLatest);
    if (after.length > 0) {
      for (const c of after) {
        qualifying.add(`comment:${item.id}:${c.username}:${c.date.getTime()}`);
      }
      itemReasons.push(
        `${plural(after.length, 'reply', 'replies')} to your comment on "${item.objectName}"`,
      );
    }
  }

  if (qualifying.size === 0) return null;

  // Item-level reasons are the specific, actionable ones — they lead. The
  // whole-list reason is the umbrella and goes last.
  const reasons = itemReasons.slice(0, MAX_ITEM_REASONS);
  if (itemReasons.length > MAX_ITEM_REASONS) {
    reasons.push(`and ${itemReasons.length - MAX_ITEM_REASONS} more of your items`);
  }

  if (ownsList && ownListItems + ownListComments > 0) {
    const parts: string[] = [];
    if (ownListItems > 0)    parts.push(plural(ownListItems, 'new item'));
    if (ownListComments > 0) parts.push(plural(ownListComments, 'comment'));
    reasons.push(`${parts.join(' and ')} on your geeklist`);
  }

  return { reasons, replyCount: qualifying.size };
}
