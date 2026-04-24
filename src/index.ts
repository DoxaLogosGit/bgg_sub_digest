// ============================================================
// index.ts — main entry point
//
// Flow:
//   1. PID lock
//   2. Load config + interests file
//   3. Launch Playwright browser, log into BGG
//   4. Scrape /subscriptions for outstanding notifications
//   5. For each subscription: fetch API content, filter to
//      the specific items BGG flagged as outstanding
//   6. Collect all content → one Claude call → digest
//   7. Write digest file
//   8. Release PID lock
//
// No state.json — BGG's subscription notification page IS the
// state. Whatever BGG shows as outstanding gets processed.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';

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

// ---- PID Lock -----------------------------------------------

const PID_FILE = path.resolve('./bgg-digest.pid');

function acquireLock(): void {
  if (fs.existsSync(PID_FILE)) {
    const existingPid = fs.readFileSync(PID_FILE, 'utf-8').trim();
    try {
      process.kill(parseInt(existingPid, 10), 0);
      log.warn(`Another digest run (PID ${existingPid}) is still running — exiting`);
      process.exit(0);
    } catch {
      log.warn('Stale PID file found, removing and continuing');
    }
  }
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
}

function releaseLock(): void {
  fs.unlink(PID_FILE, () => undefined);
}

// ---- Main ---------------------------------------------------

async function main(): Promise<void> {
  const runStart = new Date();
  log.info('=== BGG Subscription Digest starting ===', { pid: process.pid });

  acquireLock();
  process.on('exit',    releaseLock);
  process.on('SIGINT',  () => { releaseLock(); process.exit(130); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(143); });

  try {
    // ---- 1. Config + interests
    const config = loadConfig();
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

    // ---- 2. Browser + login
    const browser = await createBrowserContext(config);
    try {
      await ensureLoggedIn(browser, config);

      // ---- 3. Scrape outstanding subscriptions
      const { subscriptions, subPage } = await scrapeSubscriptions(browser, config);

      if (subscriptions.length === 0) {
        log.info('No outstanding subscriptions — nothing to process.');
        await subPage.close();
        await browser.close();
        releaseLock();
        return;
      }

      // ---- 4. API page for BGG XML requests
      //
      // fetch() inside page.evaluate() uses Chromium's TLS stack, which has the
      // right JA3/JA4 fingerprint to pass Cloudflare. The page must be on
      // boardgamegeek.com so xmlapi calls are same-origin with cookies included.
      const apiPage = await browser.newPage();
      try {
        await apiPage.goto('https://boardgamegeek.com', {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
      } catch (err) {
        log.warn('API page navigation failed — API calls may fail', { err: String(err) });
      }

      // ---- 5. Fetch content for each outstanding subscription
      const contentSections: Array<{ title: string; url: string; content: string }> = [];
      const maxItems = config.digest.maxNewItemsPerSubscription;

      for (const sub of subscriptions) {
        log.info(`Fetching: ${sub.title}`, {
          type: sub.type,
          id: sub.id,
          notifiedIds: sub.notifiedItemIds.length,
        });

        if (sub.type === 'thread') {
          const thread = await fetchThread(sub.id, config.bgg.apiKey, apiPage);
          if (!thread) {
            log.warn(`Could not fetch thread ${sub.id} — skipping`);
            continue;
          }

          const articles = recentArticles(thread.articles, maxItems);

          log.info(`Thread "${thread.subject}": ${articles.length} articles to include`);

          if (articles.length > 0) {
            contentSections.push({
              title:   thread.subject || sub.title,
              url:     sub.url,
              content: formatThreadContent(thread.subject, articles),
            });
          }

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

        // Clear the BGG shortcut for this subscription
        await clearSubscriptionShortcut(subPage, sub, config.digest.debugClear);

        await sleep(1_000); // be polite to BGG's API
      }

      await apiPage.close();
      await subPage.close();

      // ---- 6. Single Claude call for the entire digest
      log.info(`Summarizing ${contentSections.length} subscriptions in one Claude call`);

      const digestBody = summarizeAllContent(contentSections, interests);

      // ---- 7. Write digest
      const markdown = buildMarkdown(runStart, digestBody);
      const digestPath = writeDigest(markdown, config.digest.outputDir, runStart);

      log.info(`Digest complete → ${digestPath}`);
      console.log(`\nDigest written to: ${digestPath}`);

    } finally {
      await browser.close();
    }

    const elapsed = Date.now() - runStart.getTime();
    log.info(`=== Digest run complete in ${(elapsed / 1000).toFixed(1)}s ===`);

  } catch (err) {
    log.error('Fatal error in digest run', { err: String(err) });
    if (err instanceof Error && err.stack) log.error(err.stack);
    process.exit(1);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main();
