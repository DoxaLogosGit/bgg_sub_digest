// ============================================================
// bgg/api.ts — fetch thread and geeklist content via BGG XML API
//
// Important API notes:
//
//   Threads:   BGG XML API v2 — https://boardgamegeek.com/xmlapi2/thread?id=N
//   Geeklists: BGG XML API v1 — https://boardgamegeek.com/xmlapi/geeklist/N
//              (v2 has no geeklist endpoint)
//
//   BGG frequently returns HTTP 202 "queued" responses on cache
//   misses. We retry with exponential backoff until we get a 200.
//
//   The API key is passed as ?key=YOUR_KEY on every request.
//   Without it, you may get "Unauthorized" from Cloudflare or BGG.
//
//   Geeklists can be huge. We fetch all items (v1 has no pagination)
//   then filter client-side to only items newer than cutoff date.
// ============================================================

import * as xml2js from 'xml2js';
import type { Page } from 'playwright';
import { log } from '../logger';
import type { BggThread, BggThreadArticle, BggGeeklist, BggGeeklistItem, BggGeeklistComment } from '../types';

const BGG_V2 = 'https://boardgamegeek.com/xmlapi2';
const BGG_V1 = 'https://boardgamegeek.com/xmlapi';

const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000]; // exponential backoff

// ---- Low-level fetch with BGG's 202-retry behavior --------
//
// WHY page.evaluate() instead of context.request.get() or plain fetch():
//
//   BGG/Cloudflare uses TLS fingerprinting (JA3/JA4) to detect non-browser
//   clients. Even with valid cf_clearance and SessionID cookies, requests from
//   context.request.get() get rejected with 401 because the Node.js TLS stack
//   has a different fingerprint than Chromium.
//
//   Running fetch() inside page.evaluate() executes inside Chromium's own
//   rendering process, so:
//     - The TLS handshake comes from Chromium's BoringSSL (correct fingerprint)
//     - All browser cookies (cf_clearance, SessionID) are automatically included
//     - The request looks exactly like a user's browser request to BGG
//
//   The page must already be navigated to boardgamegeek.com — then all
//   xmlapi/xmlapi2 calls are same-origin and the browser sends cookies freely.
//
// In Python terms: this is equivalent to running requests inside a Selenium
// driver's execute_script() vs. making a plain requests.get() call.

async function fetchXml(url: string, page: Page, apiKey: string): Promise<string> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    // page.evaluate() runs the callback inside Chromium's renderer process.
    // The fetch() call there uses Chromium's network stack + cookie jar.
    //
    // BGG's XML API now requires the application token as an Authorization header,
    // NOT as a ?key= query parameter. Sending it as a query param returns 401.
    const result = await page.evaluate(async (args: { fetchUrl: string; token: string }) => {
      const r = await fetch(args.fetchUrl, {
        headers: {
          'Accept': 'application/xml, text/xml, */*',
          'Authorization': `Bearer ${args.token}`,
        },
        credentials: 'include',
      });
      return { status: r.status, text: await r.text() };
    }, { fetchUrl: url, token: apiKey });

    if (result.status === 200) {
      return result.text;
    }

    if (result.status === 202) {
      const delay = RETRY_DELAYS_MS[attempt] ?? 30_000;
      log.debug(`BGG returned 202 (queued), retrying in ${delay}ms`, { url, attempt });
      await sleep(delay);
      continue;
    }

    throw new Error(`BGG API HTTP ${result.status} for ${url}: ${result.text.slice(0, 200)}`);
  }

  throw new Error(`BGG API max retries exceeded for ${url}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- XML parsing helpers ----------------------------------

// xml2js returns deeply nested objects with some quirks.
// By default it wraps single-item arrays as arrays, which is
// annoying to work with. We use these helpers to normalize.

function parseXml(xmlStr: string): Promise<Record<string, unknown>> {
  return xml2js.parseStringPromise(xmlStr, {
    explicitArray: false,  // Don't wrap everything in arrays
    mergeAttrs: false,     // Keep attributes separate under '$'
    trim: true,
  });
}

// Safely access an attribute from xml2js output.
// xml2js puts XML attributes under the '$' key.
// Example: <article id="123"> → article['$'].id === '123'
function attr(node: Record<string, unknown>, name: string): string {
  const attrs = node['$'] as Record<string, string> | undefined;
  return attrs?.[name] ?? '';
}

// Parse a BGG date string to a JS Date.
// BGG dates look like "Wed, 15 Jan 2024 10:30:00 +0000" (RFC 2822)
// or sometimes ISO 8601. new Date() handles both.
function parseBggDate(dateStr: string): Date {
  if (!dateStr) return new Date(0);
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

// Strip HTML/BBCode tags for cleaner Claude prompts.
// BGG uses BBCode-style markup (like [b]bold[/b]) plus some HTML.
function stripMarkup(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')          // Remove HTML tags
    .replace(/\[\/?\w+[^\]]*\]/g, '')  // Remove BBCode tags like [b], [url=...], [/b]
    .replace(/\s+/g, ' ')              // Collapse whitespace
    .trim();
}

// Truncate long bodies so we don't blow up the Claude prompt.
// 1000 chars is plenty to understand what a post is about.
function truncate(text: string, max = 1000): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

// ---- Thread fetching (XML API v2) -------------------------

export async function fetchThread(threadId: number, apiKey: string, page: Page): Promise<BggThread | null> {
  const url = `${BGG_V2}/thread?id=${threadId}`;
  log.debug('Fetching thread', { threadId, url });

  let xmlStr: string;
  try {
    xmlStr = await fetchXml(url, page, apiKey);
  } catch (err) {
    log.error('Failed to fetch thread', { threadId, err: String(err) });
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = await parseXml(xmlStr);
  } catch (err) {
    log.error('Failed to parse thread XML', { threadId, err: String(err) });
    return null;
  }

  // xml2js wraps the root element with the tag name as the key
  // BGG v2 thread response: <thread id="..." subject="..." link="..." ...>
  const threadNode = parsed['thread'] as Record<string, unknown> | undefined;
  if (!threadNode) {
    log.warn('Unexpected thread XML structure — missing <thread> root', { threadId });
    return null;
  }

  const threadId_ = parseInt(attr(threadNode, 'id'), 10);
  const subject = attr(threadNode, 'subject');
  const link = attr(threadNode, 'link');
  const numArticles = parseInt(attr(threadNode, 'numarticles'), 10) || 0;

  // Articles are nested under <articles><article ...> </articles>
  const articlesNode = threadNode['articles'] as Record<string, unknown> | undefined;
  if (!articlesNode) {
    return { id: threadId_, subject, link, articles: [], numArticles: 0 };
  }

  // xml2js with explicitArray:false gives a single object if there's one article,
  // or an array if there are multiple. We normalize to always be an array.
  const rawArticles = articlesNode['article'];
  const articleList: Record<string, unknown>[] = Array.isArray(rawArticles)
    ? rawArticles
    : rawArticles
      ? [rawArticles as Record<string, unknown>]
      : [];

  const articles: BggThreadArticle[] = articleList.map((a) => {
    const aNode = a as Record<string, unknown>;
    const body = truncate(stripMarkup(String(aNode['body'] ?? '')));
    const articleId = parseInt(attr(aNode, 'id'), 10);
    return {
      id: articleId,
      username: attr(aNode, 'username'),
      postdate:  parseBggDate(attr(aNode, 'postdate')),
      editdate:  parseBggDate(attr(aNode, 'editdate')),
      subject:   String(aNode['subject'] ?? ''),
      body,
      // Direct link to this specific article within the thread
      link: `${link}&article=${articleId}`,
    };
  });

  log.debug(`Thread ${threadId_} fetched: ${articles.length} articles total`);
  return { id: threadId_, subject, link, articles, numArticles };
}

// ---- Geeklist fetching (XML API v1) -----------------------
// v1 returns all items in one shot (no pagination), which can
// be large for popular geeklists — but we filter immediately.

export async function fetchGeeklist(geeklistId: number, apiKey: string, page: Page): Promise<BggGeeklist | null> {
  const url = `${BGG_V1}/geeklist/${geeklistId}?comments=1`;
  log.debug('Fetching geeklist', { geeklistId, url });

  let xmlStr: string;
  try {
    xmlStr = await fetchXml(url, page, apiKey);
  } catch (err) {
    log.error('Failed to fetch geeklist', { geeklistId, err: String(err) });
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = await parseXml(xmlStr);
  } catch (err) {
    log.error('Failed to parse geeklist XML', { geeklistId, err: String(err) });
    return null;
  }

  // v1 root element is <geeklist id="...">
  const glNode = parsed['geeklist'] as Record<string, unknown> | undefined;
  if (!glNode) {
    log.warn('Unexpected geeklist XML structure', { geeklistId });
    return null;
  }

  const glId   = parseInt(attr(glNode, 'id'), 10);
  const title  = String(glNode['title'] ?? `Geeklist ${geeklistId}`);
  const username = String(glNode['username'] ?? '');
  const editdate = parseBggDate(String(glNode['editdate'] ?? ''));
  const description = truncate(stripMarkup(String(glNode['description'] ?? '')), 500);

  // Normalize item list (same single/array quirk as articles above)
  const rawItems = glNode['item'];
  const itemList: Record<string, unknown>[] = Array.isArray(rawItems)
    ? rawItems
    : rawItems
      ? [rawItems as Record<string, unknown>]
      : [];

  const items: BggGeeklistItem[] = itemList.map((i) => {
    const iNode = i as Record<string, unknown>;
    const itemId = parseInt(attr(iNode, 'id'), 10);

    // Extract comments — xml2js gives a single object when there's one comment,
    // an array when there are multiple, and undefined when there are none.
    // Comment nodes look like: <comment username="foo" date="...">text</comment>
    // xml2js with mergeAttrs:false puts attributes under '$' and text under '_'.
    const rawComments = iNode['comment'];
    const commentList: Record<string, unknown>[] = Array.isArray(rawComments)
      ? rawComments
      : rawComments
        ? [rawComments as Record<string, unknown>]
        : [];

    const comments: BggGeeklistComment[] = commentList.map((c) => ({
      username: attr(c, 'username'),
      date:     parseBggDate(attr(c, 'date')),
      body:     truncate(stripMarkup(String((c as Record<string, unknown>)['_'] ?? '')), 300),
    }));

    return {
      id: itemId,
      username:   attr(iNode, 'username'),
      postdate:   parseBggDate(attr(iNode, 'postdate')),
      editdate:   parseBggDate(attr(iNode, 'editdate')),
      objectName: attr(iNode, 'objectname'),
      objectId:   parseInt(attr(iNode, 'objectid'), 10),
      body:       truncate(stripMarkup(String(iNode['body'] ?? ''))),
      link:       `https://boardgamegeek.com/geeklist/${geeklistId}#item${itemId}`,
      comments,
      newComments: [],   // populated by filterNewItems
      itemIsNew:   false, // populated by filterNewItems
    };
  });

  log.debug(`Geeklist ${glId} fetched: ${items.length} items total`);
  return { id: glId, title, username, editdate, description, items };
}

// ---- Recency sort + cap ----------------------------------------
//
// BGG's notification page tells us WHICH subscriptions have outstanding
// activity, but not the complete list of all new items within them —
// it only shows the most recent notification row per subscription.
//
// So we fetch the full subscription from the API and take the N most
// recent items/articles. "Most recent" means highest postdate/editdate.
// The caller applies the per-subscription cap from config.

export function recentArticles(articles: BggThreadArticle[], cap: number): BggThreadArticle[] {
  return [...articles]
    .sort((a, b) => {
      const da = a.editdate > a.postdate ? a.editdate : a.postdate;
      const db = b.editdate > b.postdate ? b.editdate : b.postdate;
      return db.getTime() - da.getTime(); // newest first
    })
    .slice(0, cap);
}

export function recentItems(items: BggGeeklistItem[], cap: number): BggGeeklistItem[] {
  return [...items]
    .sort((a, b) => {
      const da = a.editdate > a.postdate ? a.editdate : a.postdate;
      const db = b.editdate > b.postdate ? b.editdate : b.postdate;
      return db.getTime() - da.getTime(); // newest first
    })
    .slice(0, cap);
}
