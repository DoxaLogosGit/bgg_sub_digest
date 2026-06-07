// ============================================================
// bgg/notifications.ts — fetch the subscription/notification feed via API
//
// WHY THIS EXISTS (the short version):
//   BGG's human-facing HTML page https://boardgamegeek.com/subscriptions is
//   behind a Cloudflare *interactive* "verify you are human" challenge that a
//   headless cron can't pass. But BGG's own Angular frontend doesn't scrape
//   that HTML — it calls a JSON backend that is NOT behind the challenge. This
//   module talks to that backend directly, so the cron never touches Cloudflare.
//
// THE THREE ENDPOINTS (all reached with Playwright's `ctx.request`, which
// shares the persistent profile's cookie jar but makes NO page navigation):
//
//   1. GET  boardgamegeek.com/api/accounts/current
//        Authed by the persisted BGG cookies (same domain). Returns JSON that
//        includes `authToken` — a short string of the form "<hex>u<userid>".
//        Verified to work with ONLY the long-lived remember-me cookies (no
//        live SessionID) — i.e. the real steady state of an unattended cron.
//
//   2. GET  api.geekdo.com/api/notice?sort=newest
//        Authed by header `Authorization: GeekAuth <authToken>`. Returns
//        { notices: [...], essentialItems: [...], links: [...] } — the feed.
//
//   3. PATCH api.geekdo.com/api/viewdate   body {"<type>":["<id>", ...]}
//        Authed by the same GeekAuth header. Marks items "viewed", which is how
//        BGG clears a notification. We call this AFTER the digest is emailed.
//
// PYTHON CONTEXT: `ctx.request` is an HTTP client (like `requests.Session`)
// that happens to share cookies with a browser context. We use it instead of
// `requests`/`fetch` because it sails through BGG's API zone cleanly and reuses
// the profile's login cookies for free.
// ============================================================

import type { APIRequestContext } from 'playwright';
import { log } from '../logger';
import type { BggSubscription, SubscriptionType } from '../types';

const BGG = 'https://boardgamegeek.com';
const GEEKDO = 'https://api.geekdo.com';

// ---- Raw shapes returned by the notice feed --------------------
//
// These mirror the JSON exactly. Every id comes back as a STRING in the feed
// (e.g. "3720248"), even though our BggSubscription uses numeric ids — we parse
// at the boundary (in the transform) and keep strings here to match the wire.

// One {type, id} reference (a thread, geeklist, article, listitem, …).
export interface NoticeRef {
  type: string;
  id: string;
}

// One notification event in the feed.
export interface RawNotice {
  triggers: NoticeRef[];     // what you subscribed to that fired this (thing/guild/geeklist/thread)
  linkItem: NoticeRef;       // the thing the row links to (thread/article/listitem/blogpost/…)
  trackingItem: NoticeRef;   // the item to PATCH viewdate on to CLEAR this notice
  item: NoticeRef;           // usually == linkItem
  group: NoticeRef;          // the GROUPING/FETCH unit: thread for articles, geeklist for listitems, …
  date: string;              // ISO 8601, e.g. "2026-06-07T17:13:19+00:00"
  eventid: number;           // monotonically increasing; newest first under sort=newest
}

// One resolved item with display metadata, parallel to the notices.
export interface EssentialItem {
  type: string;
  id: string;
  name: string;
  href: string;                          // site-relative, e.g. "/thread/3720323/slug"
  label?: string;                        // "Thread" | "Reply" | "GeekList Item" | "Blog Post" | …
  breadcrumbs?: { name: string; href: string }[];   // breadcrumbs[0].name is the parent game/context
}

export interface NoticeFeed {
  notices: RawNotice[];
  essentialItems: EssentialItem[];
  links?: { rel: string; uri: string }[];
}

// What clearViewdates() needs: the set of items to mark viewed.
export type ClearItem = NoticeRef;

// The transform's output: subscriptions for the existing pipeline, plus the
// flat list of items to clear once the digest has been sent.
export interface NoticesResult {
  subscriptions: BggSubscription[];
  clearItems: ClearItem[];
}

// ---- getAuthToken --------------------------------------------
//
// Step 1: trade the persisted BGG cookies for a GeekAuth token.
// Throws if the session is no longer valid (cookies expired) — the caller
// turns that into the "needs re-login" path.
export async function getAuthToken(request: APIRequestContext): Promise<string> {
  const res = await request.get(`${BGG}/api/accounts/current`, {
    headers: { Accept: 'application/json', Referer: `${BGG}/subscriptions` },
  });
  if (!res.ok()) {
    throw new Error(`accounts/current returned ${res.status()} — BGG session cookies may be invalid`);
  }
  // .json() parses the body; we cast to the one field we need.
  const body = (await res.json()) as { authToken?: string; username?: string };
  if (!body.authToken) {
    throw new Error('accounts/current returned no authToken — not logged in (remember-me cookies expired?)');
  }
  log.info(`BGG API session OK (user: ${body.username ?? '?'})`);
  return body.authToken;
}

// ---- fetchNoticeFeed -----------------------------------------
//
// Step 2: pull the notification feed. NOTE the feed is the "most-recent"
// window with no server-side paging (every offset/cursor param is ignored),
// so callers that need to drain a large backlog must clear + refetch.
export async function fetchNoticeFeed(request: APIRequestContext, token: string): Promise<NoticeFeed> {
  const res = await request.get(`${GEEKDO}/api/notice?sort=newest`, {
    headers: { Accept: 'application/json', Authorization: `GeekAuth ${token}`, Referer: `${BGG}/` },
  });
  if (!res.ok()) {
    throw new Error(`notice feed returned ${res.status()}`);
  }
  return (await res.json()) as NoticeFeed;
}

// ---- clearViewdates ------------------------------------------
//
// Step 3 (post-digest): mark items viewed so BGG drops them from the feed.
// Batches by type into a single PATCH: {"thread":[...], "geeklist":[...]}.
// Best-effort: a failure here is logged, not thrown — the digest already went
// out, and the worst case is the same items reappear next run (a duplicate,
// never lost data).
export async function clearViewdates(
  request: APIRequestContext,
  token: string,
  items: ClearItem[],
): Promise<void> {
  if (items.length === 0) return;

  // Group ids by type, de-duplicated. Python: defaultdict(set).
  const byType: Record<string, Set<string>> = {};
  for (const it of items) {
    (byType[it.type] ??= new Set()).add(it.id);
  }
  // Set → array for JSON. Object.fromEntries builds {type: [ids]}.
  const payload = Object.fromEntries(
    Object.entries(byType).map(([type, ids]) => [type, [...ids]]),
  );

  try {
    const res = await request.patch(`${GEEKDO}/api/viewdate`, {
      headers: {
        Accept: 'application/json',
        Authorization: `GeekAuth ${token}`,
        'Content-Type': 'application/json',
        Referer: `${BGG}/`,
      },
      data: payload,
    });
    if (res.ok()) {
      const n = Object.values(payload).reduce((sum, arr) => sum + arr.length, 0);
      log.info(`Cleared ${n} BGG notice item(s) via viewdate`, { types: Object.keys(payload) });
    } else {
      log.warn(`viewdate PATCH returned ${res.status()} — notices not cleared (will reappear next run)`);
    }
  } catch (err) {
    log.warn('viewdate PATCH failed — notices not cleared (will reappear next run)', { err: String(err) });
  }
}

// ============================================================
// transformNotices — pure mapping: feed → subscriptions + clear list
// ============================================================
//
// GROUPING: we group notices by their `group` ref ("type:id"). BGG's own feed
// uses `group` as the logical unit — all replies in a thread share
// group={thread,id}; all new items in a geeklist share group={geeklist,id};
// a new file shares group={filepage,id}; a blog post / video stands alone.
// So one group == one BggSubscription (one digest section).
//
// FETCH vs CLEAR — two different refs, don't confuse them:
//   - `group`        → what we FETCH and how we group (the subscription unit)
//   - `trackingItem` → what we PATCH to CLEAR (sometimes the item, sometimes
//                      its parent; e.g. an article's trackingItem is its thread)
//
// TITLES: come from `essentialItems` (parallel resolved metadata) — no extra
// API calls needed for names. breadcrumbs[0] is the parent game/context.
//
// This function is PURE (no I/O) so it's unit-testable — see
// notifications.transform.test.ts.
export function transformNotices(feed: NoticeFeed): NoticesResult {
  // Index essentialItems by "type:id" for O(1) lookup. Python: {f"{e['type']}:{e['id']}": e}
  const essential = new Map<string, EssentialItem>();
  for (const e of feed.essentialItems ?? []) {
    essential.set(`${e.type}:${e.id}`, e);
  }

  // Accumulator: one entry per group, keyed "type:id".
  interface Acc {
    group: NoticeRef;
    itemIds: number[];          // linkItem/item ids (article ids, listitem ids, …)
    links: NoticeRef[];         // linkItem refs — used to resolve a title when the
                                // group itself isn't in essentialItems (article→thread)
    earliest: Date;             // earliest notice date in the group
    count: number;              // number of notices (≈ unread count for this sub)
    clear: ClearItem[];         // trackingItems to mark viewed
  }
  const groups = new Map<string, Acc>();
  const clearAll: ClearItem[] = [];

  for (const n of feed.notices) {
    if (!n.group) continue;                       // defensive: skip malformed rows
    const key = `${n.group.type}:${n.group.id}`;
    const date = new Date(n.date);

    let acc = groups.get(key);
    if (!acc) {
      acc = { group: n.group, itemIds: [], links: [], earliest: date, count: 0, clear: [] };
      groups.set(key, acc);
    }
    acc.count += 1;
    if (date < acc.earliest) acc.earliest = date;
    if (n.linkItem) acc.links.push(n.linkItem);

    // Record the specific new item id (skip the group itself; for a brand-new
    // thread, item==group and there's no distinct "new reply" id to select).
    const itemId = Number.parseInt(n.item?.id ?? n.linkItem?.id ?? '', 10);
    const itemType = n.item?.type ?? n.linkItem?.type;
    if (Number.isFinite(itemId) && itemType !== n.group.type) {
      acc.itemIds.push(itemId);
    }

    // Track what to clear. Every notice contributes its trackingItem.
    if (n.trackingItem) {
      acc.clear.push(n.trackingItem);
      clearAll.push(n.trackingItem);
    }
  }

  const subscriptions: BggSubscription[] = [];
  for (const acc of groups.values()) {
    const g = acc.group;
    const id = Number.parseInt(g.id, 10);
    if (!Number.isFinite(id)) continue;

    // Prefer the group's own resolved metadata; fall back to a linked item's
    // (e.g. an article-group thread isn't itself in essentialItems, but its
    // article is — and the article's breadcrumb[0] gives the parent game).
    const ei = essential.get(`${g.type}:${g.id}`)
      ?? acc.links.map((l) => essential.get(`${l.type}:${l.id}`)).find((e) => e !== undefined);

    const url = ei?.href ? absUrl(ei.href) : canonicalUrl(g.type, g.id);
    const title = ei?.name?.trim() || `${labelFor(g.type)} ${g.id}`;
    const parentName = ei?.breadcrumbs?.[0]?.name;

    subscriptions.push({
      type: mapType(g.type),
      id,
      title,
      url,
      // Unique, ascending — matches how the rest of the pipeline expects ids.
      notifiedItemIds: [...new Set(acc.itemIds)].sort((a, b) => a - b),
      notificationDate: acc.earliest,
      unreadCount: acc.count,
      parentName,
      rowText: ei?.label ? `${ei.label}: ${title}` : title,
    });
  }

  // Stable order: newest activity first (mirrors sort=newest intent).
  subscriptions.sort((a, b) => (b.notificationDate?.getTime() ?? 0) - (a.notificationDate?.getTime() ?? 0));

  return { subscriptions, clearItems: dedupeRefs(clearAll) };
}

// ---- small pure helpers --------------------------------------

// Map the feed's group type → our SubscriptionType. Types we can fetch content
// for (thread, geeklist) map directly; the rest become stubs the digest still
// reports (title + url) but doesn't deep-fetch.
function mapType(groupType: string): SubscriptionType {
  switch (groupType) {
    case 'thread':   return 'thread';
    case 'geeklist': return 'geeklist';
    case 'blogpost': return 'blog';
    case 'filepage': return 'filepage';
    case 'boardgame':         return 'boardgame';
    case 'boardgameexpansion':return 'boardgameexpansion';
    default:         return 'unknown';   // video, comment-on-thing, etc.
  }
}

// A human label for fallback titles.
function labelFor(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

// Site-relative href → absolute. Leaves already-absolute URLs alone.
function absUrl(href: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  return `${BGG}${href.startsWith('/') ? '' : '/'}${href}`;
}

// Best-effort canonical URL when essentialItems didn't resolve a href.
function canonicalUrl(type: string, id: string): string {
  switch (type) {
    case 'thread':   return `${BGG}/thread/${id}`;
    case 'geeklist': return `${BGG}/geeklist/${id}`;
    case 'blogpost': return `${BGG}/blogpost/${id}`;
    case 'filepage': return `${BGG}/filepage/${id}`;
    case 'video':    return `${BGG}/video/${id}`;
    default:         return `${BGG}/${type}/${id}`;
  }
}

// De-duplicate {type,id} refs (used for the clear list).
function dedupeRefs(refs: NoticeRef[]): NoticeRef[] {
  const seen = new Set<string>();
  const out: NoticeRef[] = [];
  for (const r of refs) {
    const k = `${r.type}:${r.id}`;
    if (!seen.has(k)) { seen.add(k); out.push(r); }
  }
  return out;
}
