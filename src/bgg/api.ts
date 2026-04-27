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
//   The API key is sent as an Authorization: Bearer header.
//   Without it you get 401 from Cloudflare/BGG.
//
//   Geeklists can be huge. We fetch all items (v1 has no pagination)
//   then take the N most-recent items client-side.
//
// WHY page.evaluate() instead of Node.js fetch():
//
//   BGG/Cloudflare uses TLS fingerprinting (JA3/JA4) to detect non-browser
//   clients. Even with valid cf_clearance and SessionID cookies, requests from
//   Node.js's TLS stack get rejected with 401 because the fingerprint differs
//   from a real Chromium browser.
//
//   Running fetch() inside page.evaluate() executes inside Chromium's own
//   rendering process, so:
//     - The TLS handshake comes from Chromium's BoringSSL (correct fingerprint)
//     - All browser cookies (cf_clearance, SessionID) are automatically included
//     - The request looks identical to a user's normal browser request
//
//   Python equivalent: running requests inside selenium's execute_script()
//   instead of making a plain requests.get() call.
//
// PYTHON CONTEXT: xml2js is the Node.js XML parser we use. It converts
// XML to nested JavaScript objects — similar to Python's xml.etree or lxml.
// The quirky `explicitArray: false` option is explained inline below.
// ============================================================

// xml2js is a third-party npm package for parsing XML → JavaScript objects.
// Python equivalent: import xml.etree.ElementTree as ET  (or lxml)
import * as xml2js from 'xml2js';

// `type Page` from playwright — a browser tab. We use it only for page.evaluate().
import type { Page } from 'playwright';
import { log } from '../logger';

// Import our shared type definitions (interfaces defined in types.ts)
import type {
  BggThread,
  BggThreadArticle,
  BggGeeklist,
  BggGeeklistItem,
  BggGeeklistComment,
} from '../types';

const BGG_V2 = 'https://boardgamegeek.com/xmlapi2';  // Threads
const BGG_V1 = 'https://boardgamegeek.com/xmlapi';   // Geeklists

// Retry delays in milliseconds for BGG's 202 "queued" responses.
// BGG returns 202 when the requested data isn't cached yet — we wait
// and retry. The delays roughly double each time (exponential backoff).
// After all 5 delays we give up and throw an error.
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000];

// ============================================================
// fetchXml — low-level HTTP fetch that handles BGG's 202 behavior
// ============================================================
//
// Runs fetch() inside Chromium (via page.evaluate()) to bypass
// Cloudflare TLS fingerprinting. Returns the raw XML string on success.
//
// `for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++)`
// is a C-style for loop. Python equivalent: for attempt in range(6):
async function fetchXml(url: string, page: Page, apiKey: string): Promise<string> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {

    // page.evaluate() runs a callback INSIDE Chromium's renderer process.
    // The callback cannot access variables from the outer Node.js scope
    // directly — data must be passed via the second argument (serialized to JSON).
    //
    // Python Playwright equivalent:
    //   result = page.evaluate("""async (args) => {
    //     r = await fetch(args['fetchUrl'], {...})
    //     return {'status': r.status, 'text': await r.text()}
    //   }""", {'fetchUrl': url, 'token': api_key})
    //
    // The TypeScript arrow function syntax `async (args: { ... }) => { ... }`
    // is an anonymous async function — same as Python's async lambda (if it existed).
    const result = await page.evaluate(async (args: { fetchUrl: string; token: string }) => {
      // Everything inside here runs in the BROWSER, not in Node.js.
      // `fetch` here is the browser's built-in Fetch API (not Node's).
      const r = await fetch(args.fetchUrl, {
        headers: {
          'Accept': 'application/xml, text/xml, */*',
          // BGG's XML API requires Authorization: Bearer, NOT a ?key= query param.
          // Sending the key as ?key= returns 401.
          'Authorization': `Bearer ${args.token}`,
        },
        // `credentials: 'include'` means "send all cookies for this origin".
        // Since the page is on boardgamegeek.com, the browser sends
        // cf_clearance and SessionID automatically.
        credentials: 'include',
      });
      // Return a plain serializable object (not a Response — that can't cross
      // the browser↔Node boundary). page.evaluate() serializes this to JSON.
      return { status: r.status, text: await r.text() };
    }, { fetchUrl: url, token: apiKey });

    if (result.status === 200) {
      return result.text;  // Success — return the XML string
    }

    if (result.status === 202) {
      // BGG's "queued" response — the data is being fetched from their backend.
      // Wait and retry. `?? 30_000` — fallback to 30s if we've exceeded the array.
      const delay = RETRY_DELAYS_MS[attempt] ?? 30_000;
      log.debug(`BGG returned 202 (queued), retrying in ${delay}ms`, { url, attempt });
      await sleep(delay);
      continue;  // `continue` jumps to the next loop iteration — same as Python
    }

    // Any other status (401, 403, 404, 500, etc.) is an unrecoverable error.
    // We throw immediately rather than retrying.
    // `result.text.slice(0, 200)` — first 200 chars of the response body.
    // Python: result_text[:200]
    throw new Error(`BGG API HTTP ${result.status} for ${url}: ${result.text.slice(0, 200)}`);
  }

  // Reached here only if we exhausted all retry attempts on 202s
  throw new Error(`BGG API max retries exceeded for ${url}`);
}

// Simple async sleep helper.
// `new Promise<void>((resolve) => setTimeout(resolve, ms))`:
//   - new Promise() creates a Promise manually.
//   - The constructor callback receives `resolve` (call to complete) and `reject` (call to fail).
//   - setTimeout(resolve, ms) calls resolve after ms milliseconds, completing the Promise.
// Python equivalent: await asyncio.sleep(ms / 1000)
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// XML parsing helpers
// ============================================================
//
// xml2js converts XML into nested JavaScript objects. With
// `explicitArray: false`, a single child element becomes a plain
// object (not an array of one). This is convenient but means we
// must normalize single-vs-array manually at each list we care about.
//
// Example XML:    <articles><article id="1">...</article></articles>
// With 1 article: parsed.articles.article = { id: '1', ... }   ← object
// With 2+ articles: parsed.articles.article = [{ id: '1' }, { id: '2' }]  ← array
//
// We handle this normalization everywhere below with Array.isArray().

// Parse an XML string into a nested JavaScript object.
// `Promise<Record<string, unknown>>`:
//   - Record<string, unknown> = an object with string keys and unknown values.
//   - Python: dict[str, Any]
function parseXml(xmlStr: string): Promise<Record<string, unknown>> {
  return xml2js.parseStringPromise(xmlStr, {
    explicitArray: false,  // Don't wrap every element in a 1-item array
    mergeAttrs: false,     // Keep XML attributes under the '$' key (NOT merged into parent)
    trim: true,            // Strip leading/trailing whitespace from text content
  });
}

// Get an XML attribute value from an xml2js parsed node.
//
// xml2js with mergeAttrs:false stores XML attributes under the '$' key:
//   <article id="123" username="bob"> → node['$'] = { id: '123', username: 'bob' }
//
// Python equivalent (using xml.etree):
//   def attr(node, name): return node.get(name, '')
//
// `Record<string, unknown>` is the type of the node (a JS object with any keys).
// `Record<string, string> | undefined` — the '$' key is either a string-keyed
// object or undefined (if the element had no attributes).
function attr(node: Record<string, unknown>, name: string): string {
  const attrs = node['$'] as Record<string, string> | undefined;
  // Optional chaining: attrs?.['name'] returns undefined if attrs is undefined.
  // `?? ''` provides an empty string fallback.
  // Python: (attrs or {}).get(name, '')
  return attrs?.[name] ?? '';
}

// Parse a BGG date string into a JavaScript Date object.
// BGG dates look like "Wed, 15 Jan 2024 10:30:00 +0000" (RFC 2822).
// new Date() handles RFC 2822 and ISO 8601 natively.
// Python: datetime.strptime(date_str, '%a, %d %b %Y %H:%M:%S %z')
//         or dateutil.parser.parse(date_str)
function parseBggDate(dateStr: string): Date {
  if (!dateStr) return new Date(0);  // new Date(0) = Unix epoch (Jan 1 1970)
  const d = new Date(dateStr);
  // isNaN(d.getTime()) checks if the parse failed — invalid dates return NaN.
  // Python: d is None or d == datetime(1970, 1, 1)
  return isNaN(d.getTime()) ? new Date(0) : d;
}

// Strip HTML and BGG's custom BBCode markup from text for cleaner Claude prompts.
// BGG mixes HTML tags (<b>, <br>) with BBCode ([b]bold[/b], [url=...]).
//
// String.replace() with a RegExp: first arg is the pattern, second is the replacement.
// The `g` flag = global (replace ALL occurrences, not just the first).
// Python: re.sub(r'<[^>]+>', ' ', text)
function stripMarkup(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')          // Remove HTML tags: <b>, <br>, <div ...>
    .replace(/\[\/?\w+[^\]]*\]/g, '')  // Remove BBCode: [b], [/b], [url=http://...]
    .replace(/\s+/g, ' ')              // Collapse multiple whitespace to single space
    .trim();                            // Python: .strip()
}

// Truncate text that would blow up the Claude prompt.
// 1000 chars is plenty context for a post summary.
// `max = 1000` is a default parameter — same as Python's `def truncate(text, max=1000)`.
// `text.length` is Python's `len(text)`.
// Python: text[:max] + '…' if len(text) > max else text
function truncate(text: string, max = 1000): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

// ============================================================
// fetchThread — fetch a BGG forum thread via XML API v2
// ============================================================
//
// Returns null if the thread can't be fetched or parsed (so the caller
// can skip it gracefully rather than crashing the whole digest).
//
// The `| null` in the return type `Promise<BggThread | null>` means:
// "this Promise resolves to either a BggThread or null".
// Python: async def fetch_thread(...) -> Optional[BggThread]

export async function fetchThread(threadId: number, apiKey: string, page: Page): Promise<BggThread | null> {
  const url = `${BGG_V2}/thread?id=${threadId}`;
  log.debug('Fetching thread', { threadId, url });

  // Fetch the XML string, returning null on network/HTTP errors
  let xmlStr: string;
  try {
    xmlStr = await fetchXml(url, page, apiKey);
  } catch (err) {
    log.error('Failed to fetch thread', { threadId, err: String(err) });
    return null;
  }

  // Parse the XML string into a JavaScript object
  let parsed: Record<string, unknown>;
  try {
    parsed = await parseXml(xmlStr);
  } catch (err) {
    log.error('Failed to parse thread XML', { threadId, err: String(err) });
    return null;
  }

  // ---- Navigate the parsed XML structure ----
  //
  // BGG v2 thread XML structure:
  //   <thread id="3456789" subject="SGOYT April" link="https://..." numarticles="42">
  //     <articles>
  //       <article id="..." username="..." postdate="..." editdate="...">
  //         <subject>...</subject>
  //         <body>...</body>
  //       </article>
  //       ...
  //     </articles>
  //   </thread>
  //
  // xml2js represents this as:
  //   parsed = {
  //     thread: {
  //       '$': { id: '3456789', subject: 'SGOYT April', link: '...', numarticles: '42' },
  //       articles: {
  //         article: [ { '$': { id: '...', username: '...' }, body: '...', subject: '...' } ]
  //       }
  //     }
  //   }
  //
  // `as Record<string, unknown> | undefined` — TypeScript "as" is a type assertion (cast).
  // It tells the compiler "treat this value as this type". It's NOT a runtime check —
  // it's purely for the type checker. Python doesn't have an equivalent because Python
  // is dynamically typed.
  const threadNode = parsed['thread'] as Record<string, unknown> | undefined;
  if (!threadNode) {
    log.warn('Unexpected thread XML structure — missing <thread> root', { threadId });
    return null;
  }

  // Extract attributes from the <thread> element using our attr() helper
  const threadId_ = parseInt(attr(threadNode, 'id'), 10);
  const subject   = attr(threadNode, 'subject');
  const link      = attr(threadNode, 'link');
  const numArticles = parseInt(attr(threadNode, 'numarticles'), 10) || 0;

  // Get the <articles> container element
  const articlesNode = threadNode['articles'] as Record<string, unknown> | undefined;
  if (!articlesNode) {
    // Thread exists but has no articles — return empty
    return { id: threadId_, subject, link, articles: [], numArticles: 0 };
  }

  // ---- Handle the single-vs-array quirk from xml2js ----
  //
  // With explicitArray:false:
  //   - 0 articles: rawArticles = undefined
  //   - 1 article:  rawArticles = { '$': {...}, body: '...', ... }   ← plain object
  //   - N articles: rawArticles = [{ '$': {...} }, { '$': {...} }]   ← array
  //
  // We normalize to always be an array so the .map() below works uniformly.
  // Python: if isinstance(raw_articles, list): ... else: [raw_articles] if raw_articles else []
  const rawArticles = articlesNode['article'];
  const articleList: Record<string, unknown>[] = Array.isArray(rawArticles)
    ? rawArticles                                         // Already an array — use as-is
    : rawArticles
      ? [rawArticles as Record<string, unknown>]          // Single object — wrap in array
      : [];                                               // Undefined — empty array

  // ---- Map each article XML node to a BggThreadArticle ----
  //
  // Array.map() transforms each element — same as Python's list comprehension.
  // Python: [parse_article(a) for a in article_list]
  const articles: BggThreadArticle[] = articleList.map((a) => {
    const aNode = a as Record<string, unknown>;
    const body = truncate(stripMarkup(String(aNode['body'] ?? '')));
    const articleId = parseInt(attr(aNode, 'id'), 10);
    return {
      id:        articleId,
      username:  attr(aNode, 'username'),
      postdate:  parseBggDate(attr(aNode, 'postdate')),
      editdate:  parseBggDate(attr(aNode, 'editdate')),
      subject:   String(aNode['subject'] ?? ''),  // <subject> is a child element, not attribute
      body,
      // Build a direct link to this article within the thread.
      // BGG article URLs use ?article= as a query parameter.
      // We check for an existing '?' in the base link to use the right
      // separator — but BGG thread links never include query params, so
      // in practice this is always '?'.
      // Correct: https://boardgamegeek.com/thread/3456789?article=47582634
      // Wrong:   https://boardgamegeek.com/thread/3456789&article=47582634
      link: `${link}${link.includes('?') ? '&' : '?'}article=${articleId}`,
    };
  });

  log.debug(`Thread ${threadId_} fetched: ${articles.length} articles total`);
  return { id: threadId_, subject, link, articles, numArticles };
}

// ============================================================
// fetchGeeklist — fetch a BGG geeklist via XML API v1
// ============================================================
//
// v1 returns all items in one response (no pagination). Large geeklists
// can be 100+ items — we filter to the most-recent N after fetching.
//
// Returns null if the geeklist can't be fetched or parsed.

export async function fetchGeeklist(geeklistId: number, apiKey: string, page: Page): Promise<BggGeeklist | null> {
  // `?comments=1` tells the API to include comment data for each item.
  // Without it, comments are omitted from the response.
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

  // ---- Navigate the parsed XML structure ----
  //
  // BGG v1 geeklist XML structure:
  //   <geeklist id="123456">
  //     <username>creator</username>
  //     <title>My Awesome Geeklist</title>
  //     <description>...</description>
  //     <editdate>Wed, 15 Jan 2024 10:30:00 +0000</editdate>
  //     <item id="789" username="bob" objectname="Spirit Island" objectid="162886"
  //           postdate="..." editdate="...">
  //       <body>Great solo game!</body>
  //       <comment username="alice" date="...">I agree!</comment>
  //     </item>
  //     ...
  //   </geeklist>

  const glNode = parsed['geeklist'] as Record<string, unknown> | undefined;
  if (!glNode) {
    log.warn('Unexpected geeklist XML structure', { geeklistId });
    return null;
  }

  // For geeklist-level fields, some are XML attributes (under '$') and some
  // are child elements (direct keys on the node object).
  const glId        = parseInt(attr(glNode, 'id'), 10);
  const title       = String(glNode['title'] ?? `Geeklist ${geeklistId}`);  // Child element
  const username    = String(glNode['username'] ?? '');
  const editdate    = parseBggDate(String(glNode['editdate'] ?? ''));
  const description = truncate(stripMarkup(String(glNode['description'] ?? '')), 500);

  // ---- Normalize the item list (same single-vs-array quirk as articles) ----
  const rawItems = glNode['item'];
  const itemList: Record<string, unknown>[] = Array.isArray(rawItems)
    ? rawItems
    : rawItems
      ? [rawItems as Record<string, unknown>]
      : [];

  // ---- Map each item XML node to a BggGeeklistItem ----
  const items: BggGeeklistItem[] = itemList.map((i) => {
    const iNode = i as Record<string, unknown>;
    const itemId = parseInt(attr(iNode, 'id'), 10);

    // ---- Parse comments for this item ----
    //
    // BGG v1 comment XML:
    //   <comment username="alice" date="Wed, 15 Jan 2024 10:30:00 +0000">Nice pick!</comment>
    //
    // xml2js with mergeAttrs:false gives:
    //   { '$': { username: 'alice', date: '...' }, '_': 'Nice pick!' }
    //
    // `_` is xml2js's key for the text content of an element that ALSO has attributes.
    // Python xml.etree: comment.text = 'Nice pick!'

    const rawComments = iNode['comment'];
    const commentList: Record<string, unknown>[] = Array.isArray(rawComments)
      ? rawComments
      : rawComments
        ? [rawComments as Record<string, unknown>]
        : [];

    const comments: BggGeeklistComment[] = commentList.map((c) => ({
      username: attr(c, 'username'),
      date:     parseBggDate(attr(c, 'date')),
      // c['_'] is the text content — cast to Record first to access it
      body:     truncate(stripMarkup(String((c as Record<string, unknown>)['_'] ?? '')), 300),
    }));

    return {
      id:         itemId,
      username:   attr(iNode, 'username'),
      postdate:   parseBggDate(attr(iNode, 'postdate')),
      editdate:   parseBggDate(attr(iNode, 'editdate')),
      objectName: attr(iNode, 'objectname'),       // e.g. "Spirit Island"
      objectId:   parseInt(attr(iNode, 'objectid'), 10),
      body:       truncate(stripMarkup(String(iNode['body'] ?? ''))),
      // Build a direct link to this item in the geeklist
      link:       `https://boardgamegeek.com/geeklist/${geeklistId}#item${itemId}`,
      comments,
    };
  });

  log.debug(`Geeklist ${glId} fetched: ${items.length} items total`);
  return { id: glId, title, username, editdate, description, items };
}

// ============================================================
// Recency sort + cap helpers
// ============================================================
//
// BGG tells us WHICH subscriptions have outstanding activity, but not
// the exact set of new items within each subscription. So we fetch the
// entire subscription from the API and take the N most-recently-active
// items. "Most recent" = max(postdate, editdate) — whichever is later.
//
// The caller (index.ts) applies the per-subscription cap from config.
// These functions are `export`ed so index.ts can call them directly.

// Return the `cap` most-recently-active articles from a thread.
// `[...articles]` — spread operator creates a shallow copy so we don't
// mutate the original array. Python: articles[:]  or  list(articles)
//
// `.sort((a, b) => db.getTime() - da.getTime())`:
//   Array.sort() takes a comparator function that returns:
//     negative = a comes first
//     positive = b comes first
//     0        = equal
//   Subtracting timestamps gives us newest-first ordering.
//   Python: articles.sort(key=lambda a: max(a.editdate, a.postdate), reverse=True)
export function recentArticles(articles: BggThreadArticle[], cap: number): BggThreadArticle[] {
  return [...articles]
    .sort((a, b) => {
      // Use the later of postdate vs editdate as the "activity timestamp"
      const da = a.editdate > a.postdate ? a.editdate : a.postdate;
      const db = b.editdate > b.postdate ? b.editdate : b.postdate;
      // .getTime() returns milliseconds since epoch — same as datetime.timestamp()
      return db.getTime() - da.getTime(); // newest first
    })
    .slice(0, cap);  // Python: [:cap]
}

// Same pattern for geeklist items
export function recentItems(items: BggGeeklistItem[], cap: number): BggGeeklistItem[] {
  return [...items]
    .sort((a, b) => {
      const da = a.editdate > a.postdate ? a.editdate : a.postdate;
      const db = b.editdate > b.postdate ? b.editdate : b.postdate;
      return db.getTime() - da.getTime();
    })
    .slice(0, cap);
}

// ============================================================
// articlesNewerThan — return all thread articles posted after a cutoff date
// ============================================================
//
// Mirror of itemsNewerThan for threads. BGG's notification page only surfaces
// a handful of article IDs per thread even when many new posts exist — the
// same problem as geeklists. Date-based filtering solves it.
//
// For articles, "new" means postdate > cutoffDate (article was written after
// the last visit). Unlike items, we use postdate only — editdate on an article
// means the post was edited, not that it's a new reply.
//
// Returns articles sorted oldest-to-newest (reading-flow order).
//
// PYTHON CONTEXT:
//   def articles_newer_than(articles: list[BggThreadArticle], cutoff: datetime) -> list[BggThreadArticle]:
//       new_articles = [a for a in articles if a.postdate > cutoff]
//       return sorted(new_articles, key=lambda a: a.postdate)
export function articlesNewerThan(articles: BggThreadArticle[], cutoffDate: Date): BggThreadArticle[] {
  return [...articles]
    .filter((a) => a.postdate > cutoffDate)
    .sort((a, b) => a.postdate.getTime() - b.postdate.getTime());  // oldest → newest
}

// ============================================================
// itemsNewerThan — return all geeklist items with activity after a cutoff date
// ============================================================
//
// This is the primary filter for geeklist "what's new" detection.
// It's more reliable than notifiedItemIds because BGG's notification page
// only surfaces a handful of rows per subscription — even if 400+ items
// are new (e.g. SGOYT when you're two weeks behind), you might only see
// 2-3 notifiedItemIds. By contrast, notificationDate captures WHEN you
// last visited, so we can include ALL items with activity since then.
//
// "Activity" means the later of postdate and editdate — a comment added
// to an existing item updates editdate, making it appear as new activity
// even though the item itself was posted long ago.
//
// Returns items sorted newest-first (by last-activity timestamp).
// No cap is applied — the caller (index.ts) decides how many to include.
//
// PYTHON CONTEXT:
//   def items_newer_than(items: list[BggGeeklistItem], cutoff: datetime) -> list[BggGeeklistItem]:
//       def last_activity(i): return max(i.postdate, i.editdate)
//       new_items = [i for i in items if last_activity(i) > cutoff]
//       return sorted(new_items, key=last_activity, reverse=True)
export function itemsNewerThan(items: BggGeeklistItem[], cutoffDate: Date): BggGeeklistItem[] {
  return [...items]
    .filter((item) => {
      // "Last activity" = whichever is later: postdate (item added) or editdate (item edited / comment added)
      // Python: max(item.postdate, item.editdate) > cutoff_date
      const lastActivity = item.editdate > item.postdate ? item.editdate : item.postdate;
      return lastActivity > cutoffDate;
    })
    .sort((a, b) => {
      // Sort newest-first so Claude sees the most recent items first when reading the file
      const da = a.editdate > a.postdate ? a.editdate : a.postdate;
      const db = b.editdate > b.postdate ? b.editdate : b.postdate;
      return db.getTime() - da.getTime();  // newest first
    });
}
