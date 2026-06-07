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
import {
  getAuthToken,
  fetchNoticeFeed,
  transformNotices,
  clearViewdates,
} from './bgg/notifications';
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
  installWorkspaceTemplate,
  runDigest,
} from './agent';
// `import type` imports only the TypeScript type, not runtime code — erased at compile time.
// Python: from ./agent import ManifestEntry
import type { ManifestEntry, DigestResult, AgentName } from './agent';
import type { BggGeeklistItem, BggThreadArticle, BggSubscription } from './types';
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

    // Parse --agent <name> and --model <name> from CLI args.
    //   `npm start -- --agent tallow --model omnicoder-oc`
    //   `npm start -- --agent claude-ollama --model qwen3-coder-next:cloud`
    //   `npm start -- --model sonnet`                         (claude is the default agent)
    //
    // Default agent is `claude`. Default model varies by agent:
    //   - claude        → opus  (Anthropic API)
    //   - claude-ollama → qwen3-coder-next:cloud  (claude → local Ollama)
    //   - tallow        → qwen3-coder-next:cloud  (per ~/.tallow/settings.json)
    const agentArgIndex = process.argv.indexOf('--agent');
    const agentArg      = agentArgIndex !== -1 ? process.argv[agentArgIndex + 1] : 'claude';
    if (agentArg !== 'claude' && agentArg !== 'claude-ollama' && agentArg !== 'tallow') {
      throw new Error(
        `--agent must be "claude", "claude-ollama", or "tallow" (got "${agentArg}")`,
      );
    }
    const agent: AgentName = agentArg;

    const modelArgIndex = process.argv.indexOf('--model');
    const model = modelArgIndex !== -1
      ? process.argv[modelArgIndex + 1]
      : (agent === 'claude' ? 'opus' : 'qwen3-coder-next:cloud');

    // --reuse-data: skip the entire BGG download phase and run the agent
    // against whatever is already in ./digest-data/. Useful when iterating
    // on agent/model choice — no need to re-scrape BGG between runs.
    const reuseData = process.argv.includes('--reuse-data');

    // --reauth: recovery path for when the persisted BGG login cookies expire.
    // The digest reaches BGG entirely through the API zone using the remember-me
    // cookies in the browser profile (no Cloudflare, no browser navigation). Those
    // cookies last ~30 days and refresh on use, but if they ever lapse,
    // getAuthToken() fails. Running with --reauth opens a visible browser and
    // performs an interactive login to mint fresh cookies into the profile, after
    // which normal headless cron runs work again.
    const reauth = process.argv.includes('--reauth');
    if (reauth) {
      config.digest.headless = false;
      log.info('--reauth: opening a visible browser to refresh the BGG login cookies');
    }

    log.info('Config loaded', {
      scheduleMode:  config.digest.scheduleMode,
      interestsFile: config.digest.interestsFile,
      hasInterests:  interests.length > 0,
      clearSubs:     config.digest.clearSubs,
      agent,
      model,
      reuseData,
      reauth,
    });

    if (!interests) {
      log.warn(
        `No interests file found at ${config.digest.interestsFile} — ` +
        `Claude will summarize without personalization. ` +
        `Create interests.md to describe what you care about.`,
      );
    }

    // ---- Fast iteration path: --reuse-data ----------------
    //
    // Skip every BGG-side step (browser, login, scrape, fetch, file write,
    // notification clear) and run the agent against the manifest already
    // sitting in ./digest-data/ from a prior run. Lets you iterate on
    // agent/model choice in seconds instead of minutes.
    if (reuseData) {
      const digestDataDir = path.resolve('./digest-data');
      const manifestPath  = path.join(digestDataDir, 'manifest.json');

      if (!fs.existsSync(manifestPath)) {
        throw new Error(
          `--reuse-data was specified but ${manifestPath} does not exist. ` +
          `Run a normal digest first to populate ./digest-data/.`,
        );
      }

      const reusedEntries = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ManifestEntry[];
      log.info(
        `--reuse-data: skipping BGG download, running ${agent} (${model}) ` +
        `against ${reusedEntries.length} subscription(s) in ${digestDataDir}`,
      );

      const reusedDigest = await runAgentAndWriteDigest(
        agent, model, manifestPath, interests, reusedEntries, digestDataDir,
        config, runStart,
      );

      const reusedElapsed = Date.now() - runStart.getTime();
      log.info(`=== Reuse-data digest complete in ${(reusedElapsed / 1000).toFixed(1)}s ===`);
      console.log(`\nDigest written to: ${reusedDigest}`);
      return;
    }

    // ---- 2. Launch a (browserless) BGG session ------------
    //
    // We still launch a Chromium persistent context, but ONLY for its cookie
    // jar — every BGG call below goes through browser.request (Playwright's HTTP
    // client) against BGG's API zone, which is NOT behind Cloudflare's HTML-page
    // challenge. No page is ever navigated, so there's nothing for Cloudflare to
    // gate and no display/xvfb needed.
    const browser = await createBrowserContext(config);

    // `try { ... } finally { ... }` guarantees browser.close() runs (Python:
    // try/finally). The finally is at the very bottom of this block.
    try {
      // --reauth recovery: if the persisted login cookies have expired, open a
      // visible browser and log in interactively to refresh them. Skipped on the
      // normal headless path — the API session below uses the existing cookies.
      if (reauth) {
        await ensureLoggedIn(browser, config);
      }

      // ---- 3. Fetch the notification feed via the API -----
      //
      // getAuthToken trades the profile's BGG cookies for a GeekAuth token;
      // fetchNoticeFeed pulls the notice list; transformNotices groups it into
      // the same BggSubscription shape the rest of the pipeline already expects,
      // plus the flat clearItems list we PATCH *after* the digest is sent.
      const apiRequest = browser.request;
      const authToken  = await getAuthToken(apiRequest);
      const feed       = await fetchNoticeFeed(apiRequest, authToken);
      const { subscriptions, clearItems } = transformNotices(feed);
      log.info(`Fetched ${feed.notices.length} notice(s) → ${subscriptions.length} subscription(s)`);

      // If BGG shows no outstanding notifications, there's nothing to do.
      if (subscriptions.length === 0) {
        log.info('No outstanding subscriptions — nothing to process.');
        await browser.close();
        releaseLock();
        return;  // `return` in an async void function = normal exit (no digest written)
      }

      // ---- 4. Fetch content for each outstanding subscription

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

      // writeStub — emit a lightweight "there's new activity here" entry.
      // Used for (a) types we don't deep-fetch (blog/filepage/video/…) and
      // (b) thread/geeklist whose content we couldn't fetch (e.g. a 1000+ post
      // thread whose new replies are past BGG's XML API window). Because we
      // clear EVERY feed item after the digest, a stub guarantees nothing the
      // notice feed reported silently disappears — matches the no-data-loss goal.
      // `BggSubscription` is the type of `sub`; `reason` annotates why it's a stub.
      const writeStub = (sub: BggSubscription, reason?: string): void => {
        const stubMarkdown =
          `# ${sub.title}\n\n` +
          `New activity on a BGG ${sub.type} you subscribe to${reason ? ` (${reason})` : ''}.\n\n` +
          (sub.parentName ? `**Context:** ${sub.parentName}\n\n` : '') +
          `**Link:** ${sub.url}\n`;
        const filePath = writeSubscriptionFile(sub, stubMarkdown, digestDataDir);
        manifestEntries.push({
          subscriptionId:   sub.id,
          type:             sub.type,
          title:            sub.title,
          url:              sub.url,
          filePath,
          itemCount:        sub.unreadCount || 1,
          unreadCount:      sub.unreadCount,
          notificationDate: sub.notificationDate?.toISOString() ?? null,
          parentName:       sub.parentName,
        });
      };

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
          // notificationDate (per the scraper) is the EARLIEST unread row
          // date for this subscription — i.e. the oldest post we haven't
          // seen yet. So the lookback IS that date, with a small buffer
          // backwards to absorb any hour-precision boundary effects (BGG
          // dates are minute-precision, server clocks differ slightly).
          //
          // The previous code subtracted 30 days as a "monthly visit"
          // heuristic, which pulled in ~30 days of already-read posts every
          // run. With clearSubs:true and daily/weekly cron, a tight window
          // matches reality — only fetch posts since last visit.
          const BUFFER_HOURS = 2;
          const lookback = sub.notificationDate
            ? new Date(sub.notificationDate.getTime() - BUFFER_HOURS * 3600 * 1000)
            : null;
          const thread = await fetchThread(sub.id, config.bgg.apiKey, apiRequest, lookback);
          if (!thread) {
            log.warn(`Could not fetch thread ${sub.id} — emitting stub so it isn't lost`);
            writeStub(sub, 'content fetch failed');
            await sleep(1_000);
            continue;  // `continue` skips the rest of this loop iteration — same as Python
          }

          // ---- Select articles to include ----
          //
          // Belt-and-braces: even with the API-side minarticledate, also
          // filter client-side to drop anything before the lookback. Catches
          // BGG returning bonus articles or any timezone weirdness.
          //
          // When notificationDate is null (we couldn't parse a date), fall
          // back to the notifiedItemIds path or recency.
          let articles: BggThreadArticle[];

          if (sub.notificationDate !== null && lookback !== null) {
            articles = thread.articles
              .filter((a) => a.postdate.getTime() >= lookback.getTime())
              .sort((a, b) => a.postdate.getTime() - b.postdate.getTime());
          } else {
            const notified = new Set(sub.notifiedItemIds);
            articles = notified.size > 0
              ? thread.articles
                  .filter((a) => notified.has(a.id))
                  .sort((a, b) => a.postdate.getTime() - b.postdate.getTime())
              : recentArticles(thread.articles, maxItems);
          }

          // Hard-cap at maxItems regardless of selection path. The date-filter
          // path is unbounded (whatever fits in the 30-day lookback) and a
          // single 100+ article thread blows up the total digest context,
          // pushing the model into the 200K-window degenerate-output zone.
          // Delegate to the same recentArticles helper used in the fallback
          // path: sorts by latest activity DESCENDING (post or edit, whichever
          // is later) and slices the top N — so the newest items are always
          // preserved and the older ones are dropped. Output is newest-first.
          if (articles.length > maxItems) {
            const dropped = articles.length - maxItems;
            articles = recentArticles(articles, maxItems);
            log.info(`Capped thread ${sub.id} at ${maxItems} most-recent articles (dropped ${dropped} older)`);
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
            // The notice feed says there's new activity but the XML API window
            // returned nothing (e.g. a 1000+ post thread whose new replies are
            // past the API's reach). Stub it rather than drop it — we're about
            // to clear it on BGG, so a stub keeps the reader informed.
            log.info(`Thread ${sub.id} "${thread.subject}" — no fetchable new articles; emitting stub`);
            writeStub({ ...sub, title: thread.subject || sub.title }, 'new replies beyond API window');
          }

        // ---- Geeklist subscriptions ----
        } else if (sub.type === 'geeklist') {
          const geeklist = await fetchGeeklist(sub.id, config.bgg.apiKey, apiRequest);
          if (!geeklist) {
            log.warn(`Could not fetch geeklist ${sub.id} — emitting stub so it isn't lost`);
            writeStub(sub, 'content fetch failed');
            await sleep(1_000);
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

          // Hard-cap at maxItems regardless of selection path (see thread
          // path comment above for why). Delegate to recentItems — same
          // sort-by-latest-activity-then-take-top-N logic used in the
          // fallback path, so the newest items are always preserved.
          if (items.length > maxItems) {
            const dropped = items.length - maxItems;
            items = recentItems(items, maxItems);
            log.info(`Capped geeklist ${sub.id} at ${maxItems} most-recent items (dropped ${dropped} older)`);
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
            log.info(`Geeklist ${sub.id} "${geeklist.title}" — no fetchable new items; emitting stub`);
            writeStub({ ...sub, title: geeklist.title }, 'new items beyond API window');
          }

        // ---- Stub subscriptions (everything else) ----
        //
        // blog / filepage / video / boardgame / comment-on-thing / unknown:
        // types with no clean XML API for the body. The notice feed already
        // gave us the title, URL, and parent context (via essentialItems), so
        // we emit a lightweight "there's new activity here" stub. The digest
        // still surfaces it so the reader knows to check it manually — we just
        // don't fetch and summarize the full content.
        //
        // (Previously blog/filepage were scraped from the rendered DOM via
        // Playwright. That required navigating the Cloudflare-gated HTML site,
        // which the API-only flow deliberately avoids.)
        } else {
          writeStub(sub);
          log.info(`Stub ${sub.type} subscription "${sub.rowText ?? sub.title}" — new activity, no deep fetch`);
        }

        // Polite pause between API calls so we don't hammer BGG's servers.
        await sleep(1_000);
      }

      // ---- 6. Write manifest and run agent with file access ----------

      if (manifestEntries.length === 0) {
        log.info('No subscription content was successfully fetched — skipping digest');
        return;
      }

      // Write manifest.json — the agent's index of all subscription data files.
      const manifestPath = writeManifest(manifestEntries, digestDataDir);

      await runAgentAndWriteDigest(
        agent, model, manifestPath, interests, manifestEntries, digestDataDir,
        config, runStart,
      );

      // ---- 7. Clear the processed notices on BGG --------------
      //
      // ONLY reached if the digest above was built and emailed without throwing,
      // so a crash mid-run never clears un-reported items (we'd rather re-report
      // a duplicate next run than lose data). With clearSubs:false this is a
      // no-op. We clear ALL items from this feed pull (one batched PATCH).
      if (config.digest.clearSubs) {
        await clearViewdates(apiRequest, authToken, clearItems);
      } else {
        log.info(`[clearSubs:false] Would clear ${clearItems.length} notice item(s) — skipping`);
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

    // Expired-session block — the digest reaches BGG via the API zone using the
    // persisted remember-me cookies. Those last ~30 days and refresh on use, but
    // if they ever lapse, getAuthToken() / the notice feed returns an auth error.
    // Email the user so they know to run `--reauth` (interactive login refresh).
    const isAuthExpired =
      err instanceof Error &&
      (err.message.includes('accounts/current') ||
       err.message.includes('authToken') ||
       err.message.includes('notice feed returned 401') ||
       err.message.includes('notice feed returned 403'));
    if (isAuthExpired) {
      const config = loadConfig();
      if (config.email) {
        const subject = '[ACTION REQUIRED] BGG Digest — session expired';
        const body = `The BGG digest could not authenticate to BGG's API.
Your saved login cookies have likely expired, so no digest was generated today.

**To fix:** run the following once to refresh the login (a browser opens for you to sign in):

\`\`\`
npm start -- --reauth
\`\`\`

After signing in, the browser profile is updated and future scheduled runs work again.`;
        await sendDigestEmail(config.email, subject, body).catch(() => undefined);
        log.info('Session-expired notification email sent');
      }
    }

    // process.exit(1) exits immediately with code 1 (failure).
    // Python: sys.exit(1)
    process.exit(1);
  }
}

// ---- runAgentAndWriteDigest ----------------------------------
//
// Shared between the normal digest flow and the --reuse-data fast path.
// Runs the configured agent against the manifest, falls back to a stub
// digest on agent failure, writes the markdown digest file, and (if
// configured) emails it. Returns the path to the written digest.
async function runAgentAndWriteDigest(
  agent: AgentName,
  model: string,
  manifestPath: string,
  interests: string,
  entries: ManifestEntry[],
  digestDataDir: string,
  // Inline shape — only the fields we actually need from the full Config.
  config: { digest: { outputDir: string }; email?: Parameters<typeof sendDigestEmail>[0] },
  runStart: Date,
): Promise<string> {
  log.info(
    `Running ${agent} (${model}) against ${entries.length} subscription(s) from ${digestDataDir}`,
  );

  // Install the workspace template (CLAUDE.md + templates/ + INTERESTS.md)
  // into digest-data on every invocation, including --reuse-data, so edits
  // to templates/workspace/* take effect immediately on the next run.
  installWorkspaceTemplate(digestDataDir, interests);

  let digestResult: DigestResult;
  try {
    digestResult = await runDigest(agent, manifestPath, interests, model);
  } catch (err) {
    log.error(`${agent} digest run failed`, { err: String(err) });
    // Fallback — show a minimal digest pointing at the data files so the user
    // can inspect them manually if the agent can't be reached.
    digestResult = {
      body:
        `*⚠️ Summarization failed — subscription data files are in \`${digestDataDir}\`*\n\n` +
        entries
          .map((e) => `### [${e.title}](${e.url})\n${e.itemCount} items — \`${e.filePath}\``)
          .join('\n\n'),
      inputTokens:  0,
      outputTokens: 0,
      costUsd:      0,
      durationMs:   0,
    };
  }

  // ---- Status banner & subject prefix ----
  //
  // The Ollama per-subscription orchestrator (runOllamaPerSubscriptionDigest)
  // returns a `status` field on the DigestResult. Plain-claude runs leave it
  // undefined → treated as 'complete'. We prefix the email subject and
  // prepend a banner above the body for non-complete runs so the user sees
  // the failure mode at a glance instead of having to read the digest.
  const status   = digestResult.status ?? 'complete';
  const skipped  = digestResult.skipped ?? [];
  let bannerLine = '';
  let subjectPrefix = '';

  if (status === 'rate_limited') {
    subjectPrefix = '[RATE LIMITED] ';
    const completed = digestResult.completedCount ?? 0;
    const total     = digestResult.totalCount ?? 0;
    bannerLine = (
      `> ⚠️ **Rate-limited** — run halted after a 429 from the model.\n` +
      `> ${completed} of ${total} subscription(s) completed before the limit hit.\n` +
      `> Quota typically resets weekly per Ollama's policy.\n\n`
    );
  } else if (status === 'partial' || skipped.length > 0) {
    subjectPrefix = '[PARTIAL] ';
    bannerLine = (
      `> ⚠️ **Partial digest** — ${skipped.length} subscription(s) failed to summarize after retry and are linked below for manual review:\n` +
      skipped.map((s) => `> - [${s.title}] — \`${s.filePath}\``).join('\n') +
      `\n\n`
    );
  }

  const tokenFooter = formatTokenUsage(digestResult, agent, model);
  const markdown    = buildMarkdown(runStart, bannerLine + digestResult.body + '\n\n' + tokenFooter);
  const digestPath  = writeDigest(markdown, config.digest.outputDir, runStart);

  log.info(`Digest complete → ${digestPath}`, { status, completed: digestResult.completedCount, skipped: skipped.length });
  console.log(`\nDigest written to: ${digestPath}`);

  if (config.email) {
    const subject = subjectPrefix + buildEmailSubject(runStart);
    await sendDigestEmail(config.email, subject, markdown);
  }

  return digestPath;
}

// ---- formatTokenUsage ----------------------------------------
//
// Formats token usage stats from a DigestResult into a markdown footer
// line that appears at the bottom of the generated digest.
//
// Example output:
//   ---
//   *Agent: tallow (qwen3-coder-next:cloud) | Token usage: 43,924 input + 1,234 output (45,158 total) | Cost: ~$0.0463 | 45.2s*
//
// PYTHON CONTEXT: `result.inputTokens.toLocaleString()` formats a number
// with thousands separators — Python: f"{result.input_tokens:,}"
// Template literals: `${expr}` — Python: f"{expr}"
function formatTokenUsage(result: DigestResult, agent: AgentName, model: string): string {
  // Prefer the model the agent ACTUALLY used (reported in its output) over the
  // one we requested — tallow can silently fall back to its default. If they
  // differ (compared on the bare model name, ignoring any provider/ prefix),
  // show both so the fallback is visible in the digest itself.
  const bare = (m: string) => m.split('/').pop();
  const agentStr = result.actualModel && bare(result.actualModel) !== bare(model)
    ? `Agent: ${agent} (${result.actualModel}, requested ${model})`
    : `Agent: ${agent} (${result.actualModel ?? model})`;

  // If both token counts are 0, JSON parsing failed — show a fallback that
  // still identifies the agent/model so a degenerate run is still labeled.
  if (result.inputTokens === 0 && result.outputTokens === 0) {
    return `---\n*${agentStr} | Token usage: unavailable*`;
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
    `*${agentStr} | ` +
    `Token usage: ${result.inputTokens.toLocaleString()} input + ` +
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
