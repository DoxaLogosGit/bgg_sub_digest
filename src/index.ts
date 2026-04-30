// ============================================================
// index.ts — main entry point
//
// This is the script's "main module" — equivalent to Python's
// `if __name__ == '__main__': main()` block, but in TypeScript
// the top-level code runs automatically when the file is executed.
//
// Flow:
//   1. PID lock — prevent two digest runs at the same time
//   2. Load config + interests file
//   3. Launch Playwright browser, log into BGG
//   4. Scrape /subscriptions for outstanding notifications
//   5. For each subscription: fetch API content, take most-recent N items
//   6. Collect all content → one Claude call → complete digest
//   7. Write digest file
//   8. Release PID lock
//
// No state.json — BGG's subscription notification page IS the state.
// Whatever BGG shows as outstanding gets processed; the rest is ignored.
// ============================================================

// Node.js built-in filesystem module — equivalent to Python's os/pathlib
import * as fs from 'fs';
import * as path from 'path';

// ---- Import our own modules ----------------------------------
//
// TypeScript `import { foo, bar } from './module'` is like Python's
// `from module import foo, bar`. Named exports only — no default export.
//
// `import type { ... }` imports only the type (erased at compile time).
// `import { ... }` imports the actual runtime value.
import { loadConfig, loadInterests } from './config';
import { log } from './logger';
import { createBrowserContext, ensureLoggedIn } from './bgg/auth';
import { scrapeSubscriptions, clearSubscriptionShortcut } from './bgg/scraper';
import {
  fetchThread,
  fetchGeeklist,
  recentArticles,
  recentItems,
  itemsNewerThan,
} from './bgg/api';
import {
  formatThreadContent,
  formatGeeklistContent,
  writeSubscriptionFile,
  writeManifest,
  runClaudeDigest,
} from './claude';
import { fetchPageContent, formatPageContent } from './bgg/page-content';
// `import type` imports only the TypeScript type, not runtime code — erased at compile time.
// Python: from typing import TYPE_CHECKING; if TYPE_CHECKING: from .claude import ManifestEntry
import type { ManifestEntry, DigestResult } from './claude';
import type { BggGeeklistItem, BggThreadArticle } from './types';
import { buildMarkdown, writeDigest } from './digest';
import { sendDigestEmail, buildEmailSubject } from './email';

// ============================================================
// PID lock — prevent concurrent runs
// ============================================================
//
// When run from cron, a slow prior run (e.g., many subscriptions) might
// still be running when the next scheduled run fires. The PID lock
// detects this and exits cleanly rather than running two overlapping digests.
//
// Mechanism:
//   - Write our PID to a file at startup
//   - On startup, if that file exists, check if that PID is still alive
//   - If alive → the prior run is still going → exit
//   - If dead → stale file from a crashed run → delete and continue
//
// PYTHON CONTEXT: `process.pid` is Python's `os.getpid()`.
// `process.kill(pid, 0)` sends signal 0 — a "does this process exist?" probe.
// If the process is gone, it throws an error (like Python's os.kill(pid, 0)).

const PID_FILE = path.resolve('./bgg-digest.pid');

// Write our PID to the lock file. If a prior run's file exists, check
// whether that process is still alive.
function acquireLock(): void {
  if (fs.existsSync(PID_FILE)) {
    // Read the existing PID from the file
    // Python: existing_pid = int(Path(PID_FILE).read_text().strip())
    const existingPid = fs.readFileSync(PID_FILE, 'utf-8').trim();

    try {
      // process.kill(pid, 0) sends signal 0 — a non-destructive "are you alive?" check.
      // If it throws, the process is gone (stale lock file from a crash).
      // Python: os.kill(int(existing_pid), 0)  — raises OSError if process is dead
      process.kill(parseInt(existingPid, 10), 0);

      // If we get here, the process IS alive — another digest run is in progress.
      log.warn(`Another digest run (PID ${existingPid}) is still running — exiting`);
      process.exit(0);  // Exit cleanly (not an error)

    } catch {
      // process.kill threw, meaning the PID doesn't exist — stale file.
      // Remove it and continue with our own run.
      log.warn('Stale PID file found, removing and continuing');
    }
  }

  // Write our own PID to the file.
  // String(process.pid) converts the number to a string — Python: str(os.getpid())
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
}

// Remove the PID file. Called on exit (both normal and signal-induced).
function releaseLock(): void {
  // fs.unlink() is async with a no-op callback — we don't wait for it.
  // Python: os.unlink(PID_FILE)
  fs.unlink(PID_FILE, () => undefined);
}

// ============================================================
// main — the digest orchestration function
// ============================================================
//
// `async function` means this function is asynchronous — it returns a
// Promise. Inside it we can use `await` to wait for async operations.
//
// PYTHON CONTEXT: equivalent to `async def main()` in Python with asyncio.
// In Python you'd run it with `asyncio.run(main())`.
// In Node.js/TypeScript, calling an async function immediately starts it
// and returns a Promise — we call main() at the bottom of this file.
//
// `Promise<void>` — the Promise resolves to nothing (like Python `-> None`).
async function main(): Promise<void> {
  // Record the run start time for the digest header and elapsed-time logging.
  // Python: run_start = datetime.now()
  const runStart = new Date();
  log.info('=== BGG Subscription Digest starting ===', { pid: process.pid });

  acquireLock();

  // Register cleanup handlers for common exit scenarios.
  // `process.on(event, handler)` is Node's event system — like Python's
  // signal.signal() for OS signals, or atexit.register() for clean exits.
  //
  // 'exit'   — fires on process.exit() or when the event loop drains
  // 'SIGINT' — Ctrl+C (like Python's KeyboardInterrupt)
  // 'SIGTERM'— kill command (like Python's SIGTERM handler)
  //
  // Arrow function `() => { ... }` — anonymous function with no arguments.
  // Python: lambda: (release_lock(), sys.exit(130))  (though lambda can't have statements)
  process.on('exit',    releaseLock);
  process.on('SIGINT',  () => { releaseLock(); process.exit(130); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(143); });

  // `try { ... } catch (err) { ... }` — like Python's try/except.
  // Any unhandled error in the try block jumps to the catch block.
  try {
    // ---- 1. Load config and interests ----------------------

    const config    = loadConfig();
    const interests = loadInterests(config.digest.interestsFile);

    // Parse --model <name> from CLI args, e.g. `npm start -- --model sonnet`
    // process.argv: ['node', 'index.ts', '--model', 'sonnet']
    // Default to opus for best digest quality.
    const modelArgIndex = process.argv.indexOf('--model');
    const model = modelArgIndex !== -1 ? process.argv[modelArgIndex + 1] : 'opus';

    log.info('Config loaded', {
      scheduleMode:  config.digest.scheduleMode,
      interestsFile: config.digest.interestsFile,
      hasInterests:  interests.length > 0,
      debugClear:    config.digest.debugClear,
      model,
    });

    if (!interests) {
      log.warn(
        `No interests file found at ${config.digest.interestsFile} — ` +
        `Claude will summarize without personalization. ` +
        `Create interests.md to describe what you care about.`,
      );
    }

    // ---- 2. Launch browser and log into BGG ---------------

    // createBrowserContext() opens Chromium with the persistent profile.
    // `await` pauses this function until the Promise resolves (browser is ready).
    // Python: browser = await create_browser_context(config)
    const browser = await createBrowserContext(config);

    // `try { ... } finally { ... }`:
    //   The finally block runs whether we succeed, error, or return early.
    //   Here it ensures we always call browser.close() — like a context manager.
    //
    //   Python equivalent:
    //     try:
    //         ...
    //     finally:
    //         await browser.close()
    try {
      await ensureLoggedIn(browser, config);

      // ---- 3. Scrape outstanding subscriptions ------------

      // Destructuring assignment: unpack the object returned by scrapeSubscriptions().
      // Python: result = await scrape_subscriptions(browser, config)
      //         subscriptions = result['subscriptions']
      //         sub_page = result['sub_page']
      const { subscriptions, subPage } = await scrapeSubscriptions(browser, config);

      // If BGG shows no outstanding notifications, there's nothing to do.
      if (subscriptions.length === 0) {
        log.info('No outstanding subscriptions — nothing to process.');
        // Close the pages and browser before exiting
        await subPage.close();
        await browser.close();
        releaseLock();
        return;  // `return` in an async void function = normal exit (no digest written)
      }

      // ---- 4. Open a separate tab for BGG API requests ----
      //
      // We need a Chromium page that's already on boardgamegeek.com so that
      // fetch() calls inside page.evaluate() go out as same-origin requests with
      // BGG's cookies automatically included.
      //
      // Using a separate tab from the subscriptions page so we don't disrupt
      // the shortcut-clearing navigation that happens on subPage later.
      const apiPage = await browser.newPage();
      try {
        // Navigate to BGG's homepage — just needs to be the same origin.
        // 'domcontentloaded' = don't wait for all assets, just the HTML.
        await apiPage.goto('https://boardgamegeek.com', {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
      } catch (err) {
        // Navigation failure is non-fatal — the API fetches might still work
        // if the browser already has valid cookies from the profile.
        log.warn('API page navigation failed — API calls may fail', { err: String(err) });
      }

      // ---- 5. Fetch content for each outstanding subscription

      // The directory where each subscription's data is written as its own file.
      // Cleared and recreated each run so stale files from prior runs never linger.
      // Claude reads files from this directory using its Read tool.
      // Python: digest_data_dir = os.path.abspath('./digest-data')
      const digestDataDir = path.resolve('./digest-data');
      if (fs.existsSync(digestDataDir)) {
        // rmSync with recursive:true = rm -rf — safe here because we own this directory.
        // Python: shutil.rmtree(digest_data_dir, ignore_errors=True)
        fs.rmSync(digestDataDir, { recursive: true, force: true });
      }

      // Each entry records the metadata for one subscription file on disk.
      // After the loop, these are written as manifest.json for Claude to index.
      // Python: manifest_entries: list[ManifestEntry] = []
      const manifestEntries: ManifestEntry[] = [];

      // The per-subscription item cap from config (default: 15).
      // Stored in a local variable for convenience — avoids repeating
      // `config.digest.maxNewItemsPerSubscription` everywhere.
      const maxItems = config.digest.maxNewItemsPerSubscription;

      // `for...of` over the subscriptions array — same as Python's for loop.
      for (const sub of subscriptions) {
        log.info(`Fetching: ${sub.title}`, {
          type:         sub.type,
          id:           sub.id,
          notifiedIds:  sub.notifiedItemIds.length,
        });

        // ---- Thread subscriptions ----
        if (sub.type === 'thread') {
          // Pass minarticledate to BGG's API — without it, the default
          // response is the OLDEST 1000 articles (chronologically from the
          // thread's beginning), so long threads miss every new reply.
          //
          // We use a 30-day lookback BEFORE notificationDate, because BGG's
          // /subscriptions page shows only ONE row per thread (the newest
          // unread reply), not one per unread reply. notificationDate is
          // the date of the *latest* unread reply — earlier unread replies
          // are older. The 30-day window catches threads visited within the
          // last month, which covers nearly all real-world cases.
          const lookback = sub.notificationDate
            ? new Date(sub.notificationDate.getTime() - 30 * 24 * 3600 * 1000)
            : null;
          const thread = await fetchThread(sub.id, config.bgg.apiKey, apiPage, lookback);
          if (!thread) {
            log.warn(`Could not fetch thread ${sub.id} — skipping`);
            continue;  // `continue` skips the rest of this loop iteration — same as Python
          }

          // ---- Select articles to include ----
          //
          // When we passed minarticledate to the API, thread.articles already
          // contains only the post-cutoff window (typically last 30 days from
          // notificationDate). Just sort oldest→newest and use them all.
          //
          // When we DIDN'T pass a cutoff (notificationDate was null), the API
          // returned the oldest 1000 archived articles, so fall back to
          // notifiedItemIds → recency.
          let articles: BggThreadArticle[];

          if (sub.notificationDate !== null) {
            articles = [...thread.articles]
              .sort((a, b) => a.postdate.getTime() - b.postdate.getTime());
          } else {
            const notified = new Set(sub.notifiedItemIds);
            articles = notified.size > 0
              ? thread.articles
                  .filter((a) => notified.has(a.id))
                  .sort((a, b) => a.postdate.getTime() - b.postdate.getTime())
              : recentArticles(thread.articles, maxItems);
          }

          log.info(`Thread "${thread.subject}": ${articles.length} articles selected`, {
            notifiedIds:   sub.notifiedItemIds.length,
            hasDate:       sub.notificationDate !== null,
            totalArticles: thread.articles.length,
            unreadCount:   sub.unreadCount,
          });

          // Skip subscriptions that filtered to nothing — don't bloat the digest
          // with empty entries. BGG flagged it but our API fetch+filter found
          // nothing matching, which usually means the API hasn't caught up yet.
          if (articles.length > 0) {
            const threadContent  = formatThreadContent(thread.subject, articles);
            const threadFilePath = writeSubscriptionFile(sub, threadContent, digestDataDir);
            manifestEntries.push({
              subscriptionId:   sub.id,
              type:             sub.type,
              title:            thread.subject || sub.title,
              url:              sub.url,
              filePath:         threadFilePath,
              itemCount:        articles.length,
              unreadCount:      sub.unreadCount,
              notificationDate: sub.notificationDate?.toISOString() ?? null,
              parentName:       sub.parentName,
            });
          } else {
            log.info(`Skipping ${sub.type} ${sub.id} "${thread.subject}" — no new articles matched`);
          }

        // ---- Geeklist subscriptions ----
        } else if (sub.type === 'geeklist') {
          const geeklist = await fetchGeeklist(sub.id, config.bgg.apiKey, apiPage);
          if (!geeklist) {
            log.warn(`Could not fetch geeklist ${sub.id} — skipping`);
            continue;
          }

          // ---- Filter to items with new activity since the last visit ----
          //
          // BGG shows ONE gg-notice row for the entire geeklist subscription
          // (not one row per new item, unlike threads). This means notifiedItemIds
          // only has 1 ID — the oldest unread item BGG chose to link to.
          // Using IDs-first would return just that single item regardless of how
          // many items are actually new (e.g. SGOYT with 200+ items behind).
          //
          // PRIMARY: notificationDate from the section header. This tells us when
          // the oldest unread item was posted — everything newer is "new".
          //
          // FALLBACK 1: notifiedItemIds. Catches edge cases where date parsing
          // failed but BGG gave us an explicit item link.
          //
          // FALLBACK 2: recentItems(maxItems). Last resort.
          let items: BggGeeklistItem[] = [];

          if (sub.notificationDate !== null) {
            items = itemsNewerThan(geeklist.items, sub.notificationDate);
          }

          if (items.length === 0) {
            const notified = new Set(sub.notifiedItemIds);
            if (notified.size > 0) {
              items = geeklist.items
                .filter((item) => notified.has(item.id))
                .sort((a, b) => {
                  const da = a.editdate > a.postdate ? a.editdate : a.postdate;
                  const db = b.editdate > b.postdate ? b.editdate : b.postdate;
                  return db.getTime() - da.getTime();
                });
            }
          }

          if (items.length === 0) {
            items = recentItems(geeklist.items, maxItems);
          }

          log.info(`Geeklist "${geeklist.title}": ${items.length} items selected`, {
            notifiedIds: sub.notifiedItemIds.length,
            hasDate:     sub.notificationDate !== null,
            totalItems:  geeklist.items.length,
            unreadCount: sub.unreadCount,
          });

          if (items.length > 0) {
            const geeklistContent  = formatGeeklistContent(geeklist.title, items, sub.notificationDate);
            const geeklistFilePath = writeSubscriptionFile(sub, geeklistContent, digestDataDir);
            manifestEntries.push({
              subscriptionId:   sub.id,
              type:             sub.type,
              title:            geeklist.title,
              url:              sub.url,
              filePath:         geeklistFilePath,
              itemCount:        items.length,
              unreadCount:      sub.unreadCount,
              notificationDate: sub.notificationDate?.toISOString() ?? null,
              parentName:       sub.parentName,
            });
          } else {
            log.info(`Skipping ${sub.type} ${sub.id} "${geeklist.title}" — no new items matched`);
          }

        // ---- Blog post / file page subscriptions ----
        //
        // BGG XML API has no endpoint for these, so we render the page in
        // Playwright and pull the post body + comments straight out of the
        // DOM. apiPage is already on boardgamegeek.com so navigation reuses
        // the same authenticated session. A failure leaves the digest with
        // one fewer section but doesn't kill the run.
        } else if (sub.type === 'blog' || sub.type === 'filepage') {
          const kind = sub.type === 'blog' ? 'Blog Post' : 'File Page';
          const fetched = await fetchPageContent(sub.url, apiPage);
          if (!fetched) {
            log.warn(`Could not fetch ${kind.toLowerCase()} content`, { url: sub.url });
          } else {
            const pageMarkdown = formatPageContent(kind, sub.url, fetched);
            const filePath     = writeSubscriptionFile(sub, pageMarkdown, digestDataDir);
            const itemCount    = (fetched.body ? 1 : 0) + fetched.comments.length;
            manifestEntries.push({
              subscriptionId:   sub.id,
              type:             sub.type,
              title:            fetched.title || sub.title,
              url:              sub.url,
              filePath,
              itemCount,
              unreadCount:      sub.unreadCount,
              notificationDate: sub.notificationDate?.toISOString() ?? null,
              parentName:       sub.parentName,
            });
            log.info(`${kind} "${fetched.title || sub.title}" — ${fetched.comments.length} comment(s) captured`);
          }

        // ---- Boardgame / boardgameexpansion stand-alone subscriptions ----
        //
        // These are rare in practice — most game-related notifications come
        // paired with a /thread URL which we capture via the thread branch.
        // A pure /boardgame notification means BGG flagged something on the
        // game's main page (description edit, new file, etc.) without a
        // specific entry to summarize. We still log so the user knows.
        } else if (sub.type === 'boardgame' || sub.type === 'boardgameexpansion') {
          log.info(`Stand-alone ${sub.type} subscription — no specific content URL`, {
            id: sub.id,
            title: sub.title,
            url: sub.url,
            unreadCount: sub.unreadCount,
          });
        }

        // Tell BGG this subscription has been acknowledged.
        // With debugClear: true (default), this just logs — no actual clicking.
        await clearSubscriptionShortcut(subPage, sub, config.digest.debugClear);

        // Polite pause between API calls so we don't hammer BGG's servers.
        // 1 second between each subscription — with 57 subs, this adds ~1 minute.
        await sleep(1_000);
      }

      // Close both browser tabs now that we're done fetching
      await apiPage.close();
      await subPage.close();

      // ---- 6. Write manifest and run Claude with file access ----------

      if (manifestEntries.length === 0) {
        log.info('No subscription content was successfully fetched — skipping digest');
        return;
      }

      // Write manifest.json — Claude's index of all subscription data files.
      const manifestPath = writeManifest(manifestEntries, digestDataDir);
      log.info(
        `Data written: ${manifestEntries.length} subscriptions in ${digestDataDir} — running Claude`,
      );

      // runClaudeDigest() launches `claude --dangerously-skip-permissions --print`
      // which reads the manifest, then reads each subscription file, and produces
      // a markdown digest. Returns { body, inputTokens, outputTokens, costUsd, durationMs }.
      // This is synchronous — we wait for Claude to finish before continuing.
      let digestResult: DigestResult;
      try {
        digestResult = runClaudeDigest(manifestPath, interests, model);
      } catch (err) {
        log.error('Claude digest run failed', { err: String(err) });
        // Fallback — show a minimal digest pointing at the data files so the user
        // can inspect them manually if Claude can't be reached.
        digestResult = {
          body:
            `*⚠️ Summarization failed — subscription data files are in \`${digestDataDir}\`*\n\n` +
            manifestEntries
              .map((e) => `### [${e.title}](${e.url})\n${e.itemCount} items — \`${e.filePath}\``)
              .join('\n\n'),
          inputTokens:  0,
          outputTokens: 0,
          costUsd:      0,
          durationMs:   0,
        };
      }

      // Append token usage stats footer to the digest body.
      const tokenFooter = formatTokenUsage(digestResult);

      // ---- 7. Write the digest file -----------------------

      const markdown   = buildMarkdown(runStart, digestResult.body + '\n\n' + tokenFooter);
      const digestPath = writeDigest(markdown, config.digest.outputDir, runStart);

      log.info(`Digest complete → ${digestPath}`);
      console.log(`\nDigest written to: ${digestPath}`);

      // ---- 8. Email the digest (optional) -------------------
      if (config.email) {
        const subject = buildEmailSubject(runStart);
        await sendDigestEmail(config.email, subject, markdown);
      }

    } finally {
      // Close the browser regardless of success or failure.
      // This cleans up all pages and the persistent context.
      // Python: await browser.close()
      await browser.close();
    }

    // Calculate and log total elapsed time
    const elapsed = Date.now() - runStart.getTime();
    log.info(`=== Digest run complete in ${(elapsed / 1000).toFixed(1)}s ===`);
    // .toFixed(1) formats a number to 1 decimal place — Python: f'{elapsed:.1f}'

  } catch (err) {
    // Catch-all for any unhandled error in the entire digest run.
    // Log the error and exit with a non-zero code (signals failure to cron/shell).
    log.error('Fatal error in digest run', { err: String(err) });

    // If the error is an Error object (not a plain thrown value), also log its stack trace.
    // `instanceof Error` checks the prototype chain — like Python's isinstance(err, Exception).
    if (err instanceof Error && err.stack) log.error(err.stack);

    // process.exit(1) exits immediately with code 1 (failure).
    // Python: sys.exit(1)
    process.exit(1);
  }
}

// ---- formatTokenUsage ----------------------------------------
//
// Formats token usage stats from a DigestResult into a markdown footer
// line that appears at the bottom of the generated digest.
//
// Example output:
//   ---
//   *Token usage: 43,924 input + 1,234 output (45,158 total) | Cost: ~$0.0463 | 45.2s*
//
// PYTHON CONTEXT: `result.inputTokens.toLocaleString()` formats a number
// with thousands separators — Python: f"{result.input_tokens:,}"
// Template literals: `${expr}` — Python: f"{expr}"
function formatTokenUsage(result: DigestResult): string {
  // If both token counts are 0, JSON parsing failed — show a fallback.
  if (result.inputTokens === 0 && result.outputTokens === 0) {
    return '*Token usage: unavailable*';
  }

  // Ternary `condition ? value_if_true : value_if_false`
  // Python: f" | Cost: ~${cost:.4f}" if result.cost_usd > 0 else ""
  const costStr = result.costUsd > 0
    ? ` | Cost: ~$${result.costUsd.toFixed(4)}`
    : '';

  const durStr = result.durationMs > 0
    ? ` | ${(result.durationMs / 1000).toFixed(1)}s`
    : '';

  const total = result.inputTokens + result.outputTokens;

  // .toLocaleString() formats numbers with thousands separators: 43924 → "43,924"
  // Python: f"{n:,}"
  return (
    `---\n` +
    `*Token usage: ${result.inputTokens.toLocaleString()} input + ` +
    `${result.outputTokens.toLocaleString()} output ` +
    `(${total.toLocaleString()} total)${costStr}${durStr}*`
  );
}

// ---- sleep helper --------------------------------------------
//
// Async sleep used between API calls to be polite to BGG's servers.
//
// `Promise<void>` — a Promise that resolves to nothing after `ms` milliseconds.
// Python: await asyncio.sleep(ms / 1000)
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Start the script ----------------------------------------
//
// Call main() at the module's top level. Since main() is async,
// this returns a Promise. We don't `await` it here because this IS
// the top level — there's no outer async context.
//
// Unhandled Promise rejections (errors that escape main's catch block)
// are caught by Node.js and reported automatically.
//
// Python equivalent:
//   if __name__ == '__main__':
//       asyncio.run(main())
main();
