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
const URL_PATTERNS: { type: SubscriptionType; regex: RegExp }[] = [
  { type: 'thread',   regex: /\/thread\/(\d+)/   },
  { type: 'geeklist', regex: /\/geeklist\/(\d+)/ },
];

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
      // ---- Query all notification links on this page ----
      //
      // page.$$eval(selector, callback) is Playwright's "evaluate a function
      // on ALL matching elements". It runs the callback INSIDE the browser
      // process and returns a serializable result.
      //
      // Python Playwright equivalent:
      //   elements = page.query_selector_all('gg-item-link-ui a[href]')
      //   links = [{'href': el.get_attribute('href'), 'text': el.text_content()} for el in elements]
      //
      // The TypeScript version batches the extraction into ONE call to avoid
      // the round-trip overhead of calling .getAttribute() once per element.
      //
      // `(els: Element[]) => ...` — the callback receives a real DOM Element
      // array (NOT Playwright handles). `as HTMLAnchorElement[]` is a type cast
      // that tells TypeScript "trust me, these are anchor elements with .href".
      const links = await page.$$eval(
        'gg-item-link-ui a[href]',
        (els: Element[]) => (els as HTMLAnchorElement[]).map((el) => ({
          href: el.href,                       // Absolute URL (browser resolves relative URLs)
          text: el.textContent?.trim() ?? '',  // Visible link text, whitespace-stripped
        })),
      );
      // `.textContent?.trim()` — the `?` is "optional chaining":
      //   if textContent is null/undefined, don't call .trim(), just return undefined.
      //   `?? ''` — if the result is undefined/null, use '' as fallback.
      //   Python: (el.text_content() or '').strip()

      // ---- Classify each link and accumulate subscriptions ----
      for (const { href, text } of links) {
        // Determine if this URL belongs to a thread or geeklist, and get its ID
        const classified = classifyUrl(href);
        if (!classified) continue;  // Skip URLs we don't recognize (ads, nav, etc.)

        // Build the deduplication key: "thread:3456789" or "geeklist:123456"
        // Multiple notification rows from the same subscription share this key.
        const key = `${classified.type}:${classified.id}`;
        const notifiedId = extractNotifiedId(href, classified.type);

        if (!found.has(key)) {
          // First time we see this subscription — create a new entry.
          // Strip the item/article anchor from the URL to get the subscription root.
          const canonicalUrl = classified.type === 'thread'
            ? `https://boardgamegeek.com/thread/${classified.id}`
            : `https://boardgamegeek.com/geeklist/${classified.id}`;

          found.set(key, {
            type:            classified.type,
            id:              classified.id,
            title:           text || `${classified.type} ${classified.id}`,
            url:             canonicalUrl,
            notifiedItemIds: notifiedId ? [notifiedId] : [],
            // `notifiedId ? [notifiedId] : []` — if we found an ID, wrap it in
            // an array; otherwise start with an empty array.
          });
        } else if (notifiedId) {
          // We've seen this subscription before — just add the new item ID.
          // `found.get(key)!` — the `!` is a "non-null assertion operator".
          // We just confirmed .has(key) is true, so .get() won't return undefined.
          // TypeScript can't figure that out on its own, so we tell it: "trust me".
          const sub = found.get(key)!;
          if (!sub.notifiedItemIds.includes(notifiedId)) {
            sub.notifiedItemIds.push(notifiedId);
          }
        }
      }

      log.info(
        `Subscriptions page ${contentPage}: ${links.length} notification rows, ` +
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
      // .catch(() => undefined) swallows errors — if there are no shortcuts,
      // waitForSelector times out, but that's fine. We proceed regardless.
      await page.waitForSelector('gg-shortcut', { timeout: 15_000 }).catch(() => undefined);
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
// After processing a subscription, click BGG's "shortcut-remove" button
// to acknowledge it. This removes it from the subscriptions sidebar so
// the next run won't re-process it.
//
// BGG's sidebar shows GG-SHORTCUT cards, one per subscription with outstanding
// activity. Each card has a ".shortcut-remove" button.
//
// debugClear (default true): log the action WITHOUT clicking.
//   Set to false in config.json when you're ready to clear for real.
//
// `Promise<void>` — async function that returns nothing (like Python `-> None`).

export async function clearSubscriptionShortcut(
  subPage: Page,
  sub: BggSubscription,
  debugClear: boolean,
): Promise<void> {
  // Build a URL fragment to match against the shortcut card's links.
  // e.g. "/thread/3456789" or "/geeklist/123456"
  const fragment = sub.type === 'thread'
    ? `/thread/${sub.id}`
    : `/geeklist/${sub.id}`;

  // page.$$() returns ALL matching elements as an array of ElementHandles.
  // ElementHandle is a reference to a DOM element in the browser.
  // Python: sub_page.query_selector_all('gg-shortcut')
  const shortcuts = await subPage.$$('gg-shortcut');

  // Iterate over each GG-SHORTCUT card and find the one for this subscription
  for (const shortcut of shortcuts) {
    // For each shortcut card, get all the <a> href values within it.
    // shortcut.$$eval() is like page.$$eval() but scoped to this element.
    // Python: [el.get_attribute('href') for el in shortcut.query_selector_all('a[href]')]
    const hrefs = await shortcut.$$eval(
      'a[href]',
      (els: Element[]) => (els as HTMLAnchorElement[]).map((el) => el.href),
    );

    // Array.some() returns true if ANY element passes the test — like Python's any().
    // Skip this card if none of its links contain our subscription's URL fragment.
    if (!hrefs.some((href) => href.includes(fragment))) continue;

    // Found the right shortcut card!
    if (debugClear) {
      // Debug mode: just log what we would do, don't actually click
      log.info(`[DEBUG] Would click shortcut-remove for "${sub.title}" (${sub.type} ${sub.id})`);
      return;  // Early return — stop after logging
    }

    // Find the remove button within this specific shortcut card.
    // shortcut.$() is like querySelector() scoped to this element.
    // Python: remove_btn = shortcut.query_selector('.shortcut-remove')
    const removeBtn = await shortcut.$('.shortcut-remove');
    if (!removeBtn) {
      log.warn(`No .shortcut-remove button found for ${sub.type} ${sub.id}`);
      return;
    }

    // Click the button — this tells BGG we've acknowledged the subscription.
    await removeBtn.click();
    log.info(`Cleared BGG shortcut for "${sub.title}" (${sub.type} ${sub.id})`);

    // Brief pause after clicking to let BGG's Angular app process the removal
    // before we click the next one. Without this, rapid clicks can confuse the SPA.
    //
    // `new Promise<void>((resolve) => setTimeout(resolve, 500))`:
    //   Promise constructor takes a callback with `resolve` and `reject` functions.
    //   setTimeout(resolve, 500) calls resolve after 500ms, completing the Promise.
    //   Python equivalent: await asyncio.sleep(0.5)
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    return;
  }

  // No matching shortcut found in the sidebar — log at debug level (not a problem;
  // the shortcut may already have been cleared or may be on a later sidebar page).
  log.debug(`No gg-shortcut found for ${sub.type} ${sub.id}`);
}
