// ============================================================
// bgg/scraper.ts — extract outstanding subscriptions from BGG
//
// BGG's /subscriptions page shows two things:
//
//   GG-ITEM-LINK-UI elements — individual notification rows in
//   the main content area, covering all subscriptions with new
//   activity (threads + geeklists). The page is paginated with
//   a "Next Page" link. Each row's URL encodes the specific
//   item or article ID that triggered the notification.
//
//   GG-SHORTCUT elements — subscription-level cards in a sidebar,
//   each with a ".shortcut-remove" button. Clicking this tells
//   BGG the subscription has been acknowledged.
//
// This module:
//   1. Navigates to /subscriptions and all ?page=N pages
//   2. Collects unique subscriptions from GG-ITEM-LINK-UI rows,
//      including the specific item/article IDs BGG flagged
//   3. Keeps the page open for clearing shortcuts after processing
//   4. Exposes clearSubscriptionShortcut() for post-processing
//
// PYTHON CONTEXT: This is equivalent to a Selenium or Playwright-Python
// scraper. All Playwright APIs here map directly to their Python equivalents
// with snake_case names (e.g. page.$$eval → page.eval_on_selector_all).
// ============================================================

// `import type { ... } from 'playwright'` — TypeScript-only import.
// BrowserContext is the object returned by createBrowserContext() in auth.ts.
// Page is a single browser tab. The `type` keyword means these are erased
// at compile time and add zero runtime overhead.
import type { BrowserContext, Page } from 'playwright';
import { log } from '../logger';
import type { BggSubscription, SubscriptionType } from '../types';
import type { AppConfig } from '../config';

const SUBSCRIPTIONS_URL = 'https://boardgamegeek.com/subscriptions';

// ---- URL classification ---------------------------------------
//
// BGG thread and geeklist URLs always embed the numeric ID in the path.
// Examples:
//   /thread/3456789/slug-text                   → thread 3456789
//   /thread/3456789/slug#article47582634        → thread 3456789
//   /geeklist/123456/slug-text                  → geeklist 123456
//   /geeklist/123456/slug?itemid=789            → geeklist 123456
//
// We define patterns as an array of objects — Python equivalent:
//   URL_PATTERNS = [
//       {'type': 'thread',   'regex': re.compile(r'/thread/(\d+)')},
//       {'type': 'geeklist', 'regex': re.compile(r'/geeklist/(\d+)')},
//   ]
//
// `{ type: SubscriptionType; regex: RegExp }[]` means: an array of objects
// where each object has a `type` field (SubscriptionType) and a `regex`
// field (a compiled regular expression). The `[]` at the end means array.
// Order matters — classifyUrl returns the FIRST match. Thread and geeklist
// are first because when a notice contains both a /thread/ link AND a
// /boardgame/ link (the parent game), we want the more specific thread to
// be the subscription and treat the boardgame as parent context.
const URL_PATTERNS: { type: SubscriptionType; regex: RegExp }[] = [
  { type: 'thread',             regex: /\/thread\/(\d+)/             },
  { type: 'geeklist',           regex: /\/geeklist\/(\d+)/           },
  { type: 'boardgameexpansion', regex: /\/boardgameexpansion\/(\d+)/ },
  { type: 'boardgame',          regex: /\/boardgame\/(\d+)/          },
  { type: 'blog',               regex: /\/blog\/(\d+)/               },
  { type: 'filepage',           regex: /\/filepage\/(\d+)/           },
];

// Convert a slug like "nusfjord-big-box" into a human-readable name like
// "Nusfjord: Big Box". BGG's URL slugs lose punctuation, so this is a best
// effort — the result is good enough as a label in the digest.
function slugToName(slug: string): string {
  // Title-case each word; preserve common BGG conventions like "1pg" lowercase.
  return slug
    .split('-')
    .filter((w) => w.length > 0)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

// Find the first /boardgame or /boardgameexpansion link in a notice and
// return its anchor text (which carries the proper game name with colons,
// apostrophes, etc.). Falls back to a slug-derived name if the anchor has
// no text. Returns undefined if no game link is present.
function extractParentBoardgame(links: { href: string; text: string }[]): string | undefined {
  for (const link of links) {
    const m = link.href.match(/\/boardgame(?:expansion)?\/\d+\/([^/?#]+)/);
    if (!m) continue;
    return link.text.trim() || slugToName(m[1]);
  }
  return undefined;
}

// Build the canonical URL for a subscription type + id. For blog and filepage
// we KEEP the original href (which has the specific post / comment path) so
// the content fetcher can navigate directly to what BGG flagged as new.
function canonicalUrlFor(type: SubscriptionType, id: number, fallback: string): string {
  switch (type) {
    case 'thread':             return `https://boardgamegeek.com/thread/${id}`;
    case 'geeklist':           return `https://boardgamegeek.com/geeklist/${id}`;
    case 'boardgame':          return `https://boardgamegeek.com/boardgame/${id}`;
    case 'boardgameexpansion': return `https://boardgamegeek.com/boardgameexpansion/${id}`;
    case 'blog':               return fallback;
    case 'filepage':           return fallback;
    default:                   return fallback;
  }
}

// Returns the subscription type + numeric ID parsed from a BGG URL,
// or null if the URL doesn't match any known pattern.
//
// Return type: `{ type: SubscriptionType; id: number } | null`
//   The `|` is "or" — this function returns either an object OR null.
//   Python: Optional[dict] with type and id keys.
function classifyUrl(href: string): { type: SubscriptionType; id: number } | null {
  // `for...of` iterates over array elements — same as Python's for loop.
  for (const { type, regex } of URL_PATTERNS) {
    // String.match() is like Python's re.search() — returns an array of
    // capture groups if matched, or null if not matched.
    // match[0] = full match, match[1] = first capture group.
    const match = href.match(regex);
    if (match) return { type, id: parseInt(match[1], 10) };
  }
  return null;
}

// ---- extractNotifiedId ----------------------------------------
//
// Extracts the specific item/article ID that BGG embedded in the
// notification URL. Each GG-ITEM-LINK-UI notification points to a
// particular article in a thread or a particular item in a geeklist.
//
// This lets us know EXACTLY which items BGG flagged — though in practice
// we fetch the full subscription and take the most-recent N items anyway.
//
// Returns null if no item ID is found in the URL (subscription-level only).
function extractNotifiedId(href: string, type: SubscriptionType): number | null {
  if (type === 'thread') {
    // Thread notification URLs end with one of:
    //   .../thread/3456789/slug/article/47582634
    //   .../thread/3456789/slug#47582634
    //
    // `??` is the "nullish coalescing" operator — returns the left side
    // if it's not null/undefined, otherwise returns the right side.
    // Python: match = re.search(r'/article/(\d+)', href) or re.search(r'#(\d+)$', href)
    const m = href.match(/\/article\/(\d+)/) ?? href.match(/#(\d+)$/);
    return m ? parseInt(m[1], 10) : null;
  } else {
    // Geeklist notification URLs end with one of:
    //   ...?itemid=12729057
    //   .../item/6889983
    //   ...#item6889983
    //
    // We try each pattern in order; the first match wins.
    const m = href.match(/[?&]itemid=(\d+)/)
           ?? href.match(/\/item\/(\d+)/)
           ?? href.match(/#item(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }
}

// ---- parseUnreadCount ----------------------------------------
//
// Parses the total activity count from a gg-notice row's full text content.
// BGG embeds counts in the row text — the exact format varies by type:
//
//   Geeklists: "436 GeekList Items"  "1378 Comments"  (may have both)
//   Threads:   "11 Replies"          "3 more replies"
//   General:   "5 new items"         "2 new comments"
//
// Note: these are TOTAL counts on the subscription, not the unread delta.
// We still store them in the manifest so Claude knows the scale of each
// subscription (a 436-item geeklist vs a 12-item one warrants different depth).
// For threads, we count notice rows instead (one row = one unread reply) which
// IS the unread count — call this with type='thread' and it returns 0 so the
// caller can fall back to row-counting.
//
// Returns the count found, or 0 if nothing matched.
function parseUnreadCount(text: string, type: SubscriptionType): number {
  if (!text) return 0;
  // For threads, each notice row IS one new reply — caller counts rows directly.
  if (type === 'thread') return 0;

  let total = 0;

  // "N GeekList Items" — geeklist item count
  const glItems = text.match(/(\d[\d,]*)\s+GeekList\s+Items?/i);
  if (glItems) total += parseInt(glItems[1].replace(/,/g, ''), 10);

  // "N Comments" — comment count on geeklist items
  const comments = text.match(/(\d[\d,]*)\s+Comments?(?!\s+\w)/i);
  if (comments) total += parseInt(comments[1].replace(/,/g, ''), 10);

  // Fallback: "N Replies" / "N more replies" / "N new items" / "N new comments"
  if (total === 0) {
    const fallback = /(\d[\d,]*)\s+(?:more\s+|new\s+)?(?:repl(?:ies|y)|items?|comments?)/i;
    const m = text.match(fallback);
    if (m) total = parseInt(m[1].replace(/,/g, ''), 10);
  }

  return total;
}

// ---- parseNotificationDate ----------------------------------------
//
// Tries to extract a date from the full text content of a GG-ITEM-LINK-UI
// notification row. BGG renders timestamps in several formats:
//
//   Relative: "2 hours ago"  "3 days ago"  "Yesterday"  "Today"
//   Absolute: "Apr 20, 2025"  "April 20, 2025"  "2025-04-20"
//
// WHY: The XML API returns ALL comments on a geeklist item, not just new
// ones. Without a "last visited" date we can't tell which comments were
// added since the user's last visit. The notification row's timestamp is
// our best approximation — comments newer than that date are "new".
//
// Returns a Date on success, null if nothing parseable is found.
//
// PYTHON CONTEXT: equivalent to dateutil.parser.parse() for relative times.
// Python's dateutil handles "3 days ago" natively; we do it by hand here
// because there's no built-in JS equivalent.
function parseNotificationDate(rowText: string): Date | null {
  if (!rowText) return null;

  // ---- Relative time: "N minutes/hours/days/weeks ago" ----
  //
  // Regex: (\d+) captures the number, (minute|hour|day|week) captures the unit.
  // `i` flag = case-insensitive — Python: re.IGNORECASE
  const relMatch = rowText.match(/(\d+)\s+(minute|hour|day|week)s?\s+ago/i);
  if (relMatch) {
    const amount = parseInt(relMatch[1], 10);
    const unit   = relMatch[2].toLowerCase();
    const now    = new Date();
    // Map each unit to milliseconds — no JS equivalent of Python's timedelta
    const msMap: Record<string, number> = {
      minute: 60 * 1000,
      hour:   60 * 60 * 1000,
      day:    24 * 60 * 60 * 1000,
      week:   7 * 24 * 60 * 60 * 1000,
    };
    // Date arithmetic in JS uses milliseconds since epoch (Unix timestamp * 1000)
    // Python: datetime.now() - timedelta(milliseconds=ms)
    return new Date(now.getTime() - ((msMap[unit] ?? 0) * amount));
  }

  // "Yesterday" — treat as midnight of yesterday
  // `.test()` = Python's bool(re.search(...))
  if (/yesterday/i.test(rowText)) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    d.setHours(0, 0, 0, 0);  // midnight — Python: d.replace(hour=0, minute=0, second=0)
    return d;
  }

  // "Today" or "Just now"
  if (/\btoday\b|\bjust now\b/i.test(rowText)) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  // Month-name absolute date: "Apr 20, 2025", "April 20, 2025", or "Apr 20" (no year)
  //
  // BGG omits the year when the date is in the current year — e.g. "Apr 20" instead
  // of "Apr 20, 2025". `new Date("Apr 20")` in Node.js V8 parses to year 2001, not
  // the current year, so we must supply the year manually when it's absent.
  //
  // We default to the current year, then step back one year if the resulting date is
  // in the future (handles the edge case of a "Dec 31" notification seen in January).
  // The `\b` after `\d{1,2}` is critical: without it, the pattern matches "April 20"
  // out of "April 2026 Shopping" (greedily consumes 2 digits of the year). With \b,
  // it requires a word boundary — fails inside a 4-digit year because adjacent digits
  // have no word boundary between them.
  const monthNamePattern = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}\b(?:,\s+\d{4})?/i;
  const monthMatch = rowText.match(monthNamePattern);
  if (monthMatch) {
    const matched = monthMatch[0];
    // Check whether the match already contains a 4-digit year.
    // Python: bool(re.search(r'\d{4}', matched))
    const hasYear = /\d{4}/.test(matched);
    // If no year, append the current year so Node.js doesn't default to 2001.
    // Python: f"{matched}, {datetime.now().year}" if not has_year else matched
    const dateStr = hasYear ? matched : `${matched}, ${new Date().getFullYear()}`;
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      // If the resulting date is in the future (e.g. "Dec 31" seen in January),
      // subtract one year — BGG notification dates are never in the future.
      if (d > new Date()) d.setFullYear(d.getFullYear() - 1);
      return d;
    }
  }

  // Numeric absolute: "2025-04-20" (ISO) or "04/20/2025" (US)
  const numericMatch = rowText.match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})\b/);
  if (numericMatch) {
    const d = new Date(numericMatch[1]);
    if (!isNaN(d.getTime())) return d;
  }

  return null;
}

// ============================================================
// scrapeSubscriptions — main export
// ============================================================
//
// Navigates to /subscriptions (and all ?page=N pages) and collects
// all unique outstanding subscriptions from GG-ITEM-LINK-UI rows.
//
// Returns: an object with:
//   subscriptions — the list of unique BggSubscription objects
//   subPage       — the still-open Page, reused by clearSubscriptionShortcut()
//
// Why keep subPage open? Navigating AWAY from the subscriptions page would
// lose our place in the shortcut sidebar. We process content, then come
// back to clear each shortcut one by one on the same page.
//
// PYTHON CONTEXT: the return type `Promise<{ subscriptions: BggSubscription[]; subPage: Page }>`
// is like `async def scrape(...) -> dict` that returns a dict with two keys.
// TypeScript just makes the shape explicit.

export async function scrapeSubscriptions(
  context: BrowserContext,
  _config: AppConfig,   // _config: underscore prefix = "intentionally unused" (TypeScript convention)
): Promise<{ subscriptions: BggSubscription[]; subPage: Page }> {
  // Open a new browser tab for the subscriptions page
  const page = await context.newPage();

  // The try/catch/throw pattern here ensures that if an error occurs,
  // we close the page before re-throwing so we don't leak browser tabs.
  // Python equivalent:
  //   try:
  //       ...
  //   except Exception:
  //       page.close()
  //       raise
  try {
    log.info('Navigating to BGG subscriptions page');

    // Navigate and wait for HTML to parse (not full page load — faster)
    await page.goto(SUBSCRIPTIONS_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // If BGG redirected us to /login, our session expired.
    // page.url() returns the current URL after any redirects.
    if (page.url().includes('/login')) {
      throw new Error(
        'BGG redirected /subscriptions to /login — session expired. ' +
        'Delete bgg-browser-profile/ and re-run.',
      );
    }

    // ---- Wait for notification rows to render ----
    //
    // BGG's subscriptions page is an Angular SPA. The HTML arrives quickly
    // but Angular renders the custom elements (gg-item-link-ui) asynchronously.
    // We must wait for them to appear before querying.
    //
    // waitForSelector() polls the DOM until the selector appears or times out.
    // Python: page.wait_for_selector('gg-item-link-ui', timeout=30000)
    //
    // We wrap this in try/catch because if there are NO notifications,
    // the element never appears and the timeout fires — but that's valid
    // (we're all caught up, nothing to process).
    let hasNotifications = true;
    try {
      await page.waitForSelector('gg-item-link-ui', { timeout: 30_000 });
    } catch {
      // No notifications found within 30 seconds — assume we're caught up.
      hasNotifications = false;

      // Save a screenshot so we can manually verify this was correct
      await page.screenshot({ path: `./logs/debug-subscriptions-${Date.now()}.png`, fullPage: true });
      log.info('No outstanding notifications found — all subscriptions are caught up.');
    }

    // Always save a screenshot of the subscriptions page for debugging
    const screenshotPath = `./logs/subscriptions-page-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });
    log.info(`Subscriptions page screenshot saved to ${screenshotPath}`);

    if (!hasNotifications) {
      return { subscriptions: [], subPage: page };
    }

    // ---- Collect subscriptions across all pages ----
    //
    // BGG paginates notifications — if you have many outstanding subscriptions,
    // they're split across multiple pages (/subscriptions?page=2, ?page=3, etc.).
    // We loop until we don't find a "Next" link.
    //
    // `Map<string, BggSubscription>` is like Python's dict[str, BggSubscription].
    // Key = "type:id" string (e.g. "thread:3456789"), value = the subscription object.
    // We use a Map (not plain object) because Map preserves insertion order and has
    // explicit .has(), .get(), .set() methods — more predictable than plain objects.
    const found = new Map<string, BggSubscription>();
    let contentPage = 1;

    // `while (true)` = infinite loop, broken by `break` when no Next page exists.
    // Python: while True: ... if not next_link: break
    while (true) {
      // ---- Query all notification rows on this page ----
      //
      // BGG's /subscriptions DOM:
      //   - Each new item is one <gg-notice> "row" containing one or more
      //     <gg-item-link-ui> link elements. The href on the main link
      //     encodes the specific item/article ID that triggered the notice.
      //   - Notices are grouped under <h3 class="subscription-date-title">
      //     headings ("Today", "Yesterday", "Apr 21, 2026", etc.) — the
      //     section header IS the notification date for every row beneath it.
      //   - Row text contains TOTAL counts for the underlying subscription
      //     ("11 Replies", "436 GeekList Items 1378 Comments") — these are
      //     NOT unread counts. The unread count for a subscription is the
      //     NUMBER OF NOTICE ROWS that point to it.
      //
      // We pass an evaluate script as a string (not an arrow fn) because
      // tsx/esbuild rewrites nested function declarations in evaluate
      // callbacks in a way that references Node-only `__name`, which
      // throws inside the browser context.
      const rows = await page.evaluate(`(() => {
        // Walk the DOM in document order, tracking the most recent
        // subscription-date-title header. Every notice we hit inherits
        // that header's text as its date string.
        var out = [];
        var currentHeader = '';

        // Pull all date headers and notices in document order via a
        // single querySelectorAll, then sort by document position.
        var nodes = Array.from(document.querySelectorAll(
          'h3.subscription-date-title, gg-notice'
        ));

        for (var i = 0; i < nodes.length; i++) {
          var n = nodes[i];
          if (n.tagName === 'H3') {
            currentHeader = (n.textContent || '').replace(/\\s+/g, ' ').trim();
            continue;
          }
          // It's a gg-notice. Collect every <a href> inside its
          // gg-item-link-ui descendants. We deliberately ignore other
          // anchors (avatars, "Mark as Read", etc.) to focus on the
          // links we know how to classify.
          var links = [];
          var linkEls = n.querySelectorAll('gg-item-link-ui a[href]');
          for (var j = 0; j < linkEls.length; j++) {
            var a = linkEls[j];
            links.push({
              href: a.href,
              text: (a.textContent || '').trim()
            });
          }
          out.push({
            links: links,
            // The row's text content (incl. "N Replies", "1 Thread"
            // indicators). Used as a fallback signal for brand-new
            // threads — current code primarily uses the section header
            // for the date and the link IDs for what to fetch.
            fullText: (n.textContent || '').replace(/\\s+/g, ' ').trim(),
            // The date heading that this notice falls under.
            headerText: currentHeader
          });
        }
        return out;
      })()`) as Array<{
        links: { href: string; text: string }[];
        fullText: string;
        headerText: string;
      }>;

      // Earliest (oldest) date per subscription — the right cutoff for
      // "include everything newer than this." Multiple rows for the same
      // subscription land under multiple date headers; we keep the oldest.
      const earliestNotifDate = new Map<string, Date>();

      // ---- Process each notification row ----
      for (const row of rows) {
        // The date for this row comes from the section header above it
        // ("Today", "Yesterday", "Apr 21, 2026"). The row text itself only
        // carries TOTAL counts, not unread or per-row dates.
        const rowDate = parseNotificationDate(row.headerText);

        // Find the MOST SPECIFIC link in this notice — URL_PATTERNS is ordered
        // thread > geeklist > boardgame > expansion > blog > filepage, so the
        // first classifying link wins. A notice with both a thread URL and a
        // boardgame URL becomes a thread subscription (with the boardgame as
        // parent context). A notice with only a /boardgame URL becomes a
        // boardgame subscription.
        let primaryLink: { href: string; text: string; classified: { type: SubscriptionType; id: number } } | null = null;
        for (const link of row.links) {
          const classified = classifyUrl(link.href);
          if (classified) { primaryLink = { ...link, classified }; break; }
        }
        if (!primaryLink) continue;

        const { href, text, classified } = primaryLink;
        const key = `${classified.type}:${classified.id}`;

        // Look at sibling links for a /boardgame URL — it's the parent game
        // for thread/geeklist/blog/filepage subs (e.g. a Nusfjord file page
        // notice carries a /boardgameexpansion link to "Nusfjord: Big Box").
        // Skip when the subscription IS the boardgame itself.
        const parentName =
          classified.type === 'boardgame' || classified.type === 'boardgameexpansion'
            ? undefined
            : extractParentBoardgame(row.links);

        const notifiedId = extractNotifiedId(href, classified.type);

        // For threads, each notice row is one new reply → count rows.
        // For geeklists/blogs/etc., parse the count from the row text (BGG
        // embeds totals like "436 GeekList Items" or "11 Replies" in the row).
        const parsedCount = parseUnreadCount(row.fullText, classified.type);

        if (!found.has(key)) {
          const canonicalUrl = canonicalUrlFor(classified.type, classified.id, href);

          found.set(key, {
            type:             classified.type,
            id:               classified.id,
            title:            text || `${classified.type} ${classified.id}`,
            url:              canonicalUrl,
            notifiedItemIds:  notifiedId ? [notifiedId] : [],
            notificationDate: rowDate,
            // Threads: 1 (will be incremented per row). Others: parsed from text.
            unreadCount:      classified.type === 'thread' ? 1 : (parsedCount || 1),
            parentName,
            rowText:          row.fullText,
          });

          if (rowDate) earliestNotifDate.set(key, rowDate);

        } else {
          const sub = found.get(key)!;

          if (notifiedId && !sub.notifiedItemIds.includes(notifiedId)) {
            sub.notifiedItemIds.push(notifiedId);
          }

          // Threads accumulate one count per notice row (each = one new reply).
          // For others, take the max of what we've seen — multiple rows for the
          // same geeklist should all report the same total, but take the largest
          // in case BGG updates the count between page loads.
          if (sub.type === 'thread') {
            sub.unreadCount += 1;
          } else if (parsedCount > sub.unreadCount) {
            sub.unreadCount = parsedCount;
          }

          // Keep the parent name once we've seen it — sibling rows for the
          // same subscription typically all carry the same /boardgame URL.
          if (parentName && !sub.parentName) sub.parentName = parentName;

          if (rowDate) {
            const existing = earliestNotifDate.get(key);
            if (!existing || rowDate < existing) {
              earliestNotifDate.set(key, rowDate);
              sub.notificationDate = rowDate;
            }
          }
        }
      }

      log.info(
        `Subscriptions page ${contentPage}: ${rows.length} notification rows, ` +
        `${found.size} unique subscriptions so far`,
      );

      // ---- Check for a next page ----
      //
      // BGG's "Next" link is an <a> element with aria-label="Next".
      // When disabled (last page), it has aria-disabled="true".
      // We only continue if we find a Next link with aria-disabled="false".
      //
      // page.$() returns ONE element handle or null — like querySelector().
      // Python: page.query_selector('a[aria-label="Next"][aria-disabled="false"]')
      const nextEnabled = await page.$('a[aria-label="Next"][aria-disabled="false"]');
      if (!nextEnabled) break;  // No more pages — exit the loop

      // Navigate to the next page
      contentPage++;
      await page.goto(`${SUBSCRIPTIONS_URL}?page=${contentPage}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      // Wait for rows to render before querying the next page
      await page.waitForSelector('gg-item-link-ui', { timeout: 15_000 });
    }

    // ---- Navigate back to page 1 ----
    //
    // After collecting all pages, we return to page 1 so that
    // clearSubscriptionShortcut() can find the GG-SHORTCUT sidebar
    // in its initial state (sidebar doesn't paginate the same way).
    if (contentPage > 1) {
      await page.goto(SUBSCRIPTIONS_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      // Wait for gg-notice rows to render so clearSubscriptionShortcut() can
      // find button.quick-read-btn inside them. Without this, the Angular SPA
      // may not have rendered the notice rows by the time we try to click.
      await page.waitForSelector('gg-notice', { timeout: 15_000 }).catch(() => undefined);
    }

    // `[...found.values()]` — spread the Map's values into an Array.
    // Map.values() returns an iterator; the spread operator [...iter]
    // collects it into a plain array.
    // Python: list(found.values())
    const all = [...found.values()];

    log.info(`Outstanding subscriptions: ${all.length}`, {
      // Array.filter() returns a new array of elements that pass the test.
      // Python: len([s for s in all if s.type == 'thread'])
      threads:   all.filter((s) => s.type === 'thread').length,
      geeklists: all.filter((s) => s.type === 'geeklist').length,
      pages:     contentPage,
    });

    return { subscriptions: all, subPage: page };

  } catch (err) {
    // Close the page before re-throwing so we don't leak a browser tab.
    await page.close();
    // `throw err` re-throws the caught error — same as Python's `raise`
    throw err;
  }
}

// ============================================================
// clearSubscriptionShortcut — post-processing cleanup
// ============================================================
//
// After processing a subscription, click each per-row "Mark as Read" button
// (`button.quick-read-btn` inside `<gg-notice>`) so BGG drops the row on the
// next visit. A subscription with N new replies has N notice rows on the
// /subscriptions page, each with its own button — we click them all.
//
// The button is `tw-invisible tw-hidden` until the row is hovered, so we
// invoke `.click()` directly on the DOM element via `evaluate` rather than
// going through Playwright's mouse-based click which would respect visibility.
//
// debugClear (default true): log the action WITHOUT clicking.

export async function clearSubscriptionShortcut(
  subPage: Page,
  sub: BggSubscription,
  debugClear: boolean,
): Promise<void> {
  // URL fragment that identifies this subscription on the page.
  // Matches the path segment in notice row links.
  const fragment = `/${sub.type}/${sub.id}`;

  if (debugClear) {
    // Match the row count we'd click in non-debug mode so the log is honest.
    const wouldClick = await subPage.evaluate(({ frag }: { frag: string }) => {
      const notices = Array.from(document.querySelectorAll('gg-notice'));
      let count = 0;
      for (const n of notices) {
        const links = n.querySelectorAll('a[href]');
        let matches = false;
        for (let i = 0; i < links.length; i++) {
          if ((links[i] as HTMLAnchorElement).href.includes(frag)) { matches = true; break; }
        }
        if (matches && n.querySelector('button.quick-read-btn')) count++;
      }
      return count;
    }, { frag: fragment });
    log.info(`[DEBUG] Would click ${wouldClick} quick-read-btn(s) for "${sub.title}" (${sub.type} ${sub.id})`);
    return;
  }

  // Click every quick-read-btn inside notices that reference this subscription.
  // We do it in one evaluate call — DOM mutations during clicking would
  // invalidate ElementHandles between calls otherwise.
  const clicked = await subPage.evaluate(({ frag }: { frag: string }) => {
    const notices = Array.from(document.querySelectorAll('gg-notice'));
    let count = 0;
    for (const n of notices) {
      const links = n.querySelectorAll('a[href]');
      let matches = false;
      for (let i = 0; i < links.length; i++) {
        if ((links[i] as HTMLAnchorElement).href.includes(frag)) { matches = true; break; }
      }
      if (!matches) continue;
      const btn = n.querySelector('button.quick-read-btn') as HTMLButtonElement | null;
      if (btn) {
        btn.click();
        count++;
      }
    }
    return count;
  }, { frag: fragment }).catch((err: unknown) => {
    log.warn(`clearSubscriptionShortcut: evaluate failed for ${sub.type} ${sub.id}`, { err: String(err) });
    return 0;
  });

  if (clicked > 0) {
    log.info(`Cleared ${clicked} BGG notice row(s) for "${sub.title}" (${sub.type} ${sub.id})`);
    // Pause to let BGG's Angular app process the removals before the next sub.
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  } else {
    log.debug(`No quick-read-btn found for ${sub.type} ${sub.id} — already cleared or not on page`);
  }
}
