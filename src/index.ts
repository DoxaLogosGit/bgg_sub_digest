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
} from './bgg/api';
import {
  summarizeAllContent,
  formatThreadContent,
  formatGeeklistContent,
} from './claude';
import { buildMarkdown, writeDigest } from './digest';

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

    log.info('Config loaded', {
      scheduleMode:  config.digest.scheduleMode,
      interestsFile: config.digest.interestsFile,
      hasInterests:  interests.length > 0,
      debugClear:    config.digest.debugClear,
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

      // This array accumulates formatted content for all subscriptions.
      // Type annotation: `Array<{ title: string; url: string; content: string }>`
      // = an array of plain objects with those three fields.
      // Python: content_sections: list[dict[str, str]] = []
      const contentSections: Array<{ title: string; url: string; content: string }> = [];

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
          // fetchThread() returns a BggThread object or null on failure.
          const thread = await fetchThread(sub.id, config.bgg.apiKey, apiPage);
          if (!thread) {
            log.warn(`Could not fetch thread ${sub.id} — skipping`);
            continue;  // `continue` skips the rest of this loop iteration — same as Python
          }

          // Take the N most-recently-active articles (sorted by max(postdate, editdate))
          const articles = recentArticles(thread.articles, maxItems);
          log.info(`Thread "${thread.subject}": ${articles.length} articles to include`);

          // Only add to contentSections if there's something to show.
          // An empty articles array would produce a useless section in Claude's output.
          if (articles.length > 0) {
            contentSections.push({
              // Prefer the thread's actual subject over the scraped title (more reliable)
              title:   thread.subject || sub.title,
              url:     sub.url,
              content: formatThreadContent(thread.subject, articles),
            });
          }

        // ---- Geeklist subscriptions ----
        } else if (sub.type === 'geeklist') {
          const geeklist = await fetchGeeklist(sub.id, config.bgg.apiKey, apiPage);
          if (!geeklist) {
            log.warn(`Could not fetch geeklist ${sub.id} — skipping`);
            continue;
          }

          const items = recentItems(geeklist.items, maxItems);
          log.info(`Geeklist "${geeklist.title}": ${items.length} items to include`);

          if (items.length > 0) {
            contentSections.push({
              title:   geeklist.title,
              url:     sub.url,
              content: formatGeeklistContent(geeklist.title, items),
            });
          }
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

      // ---- 6. Build the complete digest via one Claude call

      log.info(`Summarizing ${contentSections.length} subscriptions in one Claude call`);

      // summarizeAllContent() builds the prompt, calls `claude --print`,
      // and returns Claude's markdown response.
      // This is synchronous (claude --print blocks until Claude responds).
      const digestBody = summarizeAllContent(contentSections, interests);

      // ---- 7. Write the digest file -----------------------

      const markdown   = buildMarkdown(runStart, digestBody);
      const digestPath = writeDigest(markdown, config.digest.outputDir, runStart);

      log.info(`Digest complete → ${digestPath}`);

      // console.log() goes to stdout (not the log file) — useful for
      // piping the path to another command or just seeing it clearly.
      console.log(`\nDigest written to: ${digestPath}`);

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
