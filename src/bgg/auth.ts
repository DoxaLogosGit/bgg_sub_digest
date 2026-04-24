// ============================================================
// bgg/auth.ts — Playwright browser initialization and BGG login
//
// BGG is behind Cloudflare, so we can't use plain HTTP requests
// for anything that requires a session. Instead we use Playwright
// with a *persistent browser profile* (like a real Chrome profile
// directory on disk). This means:
//
//  - Cloudflare clearance cookies are kept between runs (~24h TTL)
//  - BGG session cookies stay logged in between runs
//  - No re-login needed on most days
//
// PYTHON CONTEXT: Playwright has first-class Python bindings
// (playwright-python) so concepts here map 1:1. The key difference
// is that Python Playwright can be used synchronously (sync_playwright)
// while TypeScript Playwright is always async/await.
//
// If the first run hangs on Cloudflare's challenge page, set
// headless: false in config.json, run once, then flip it back.
// ============================================================

// `import { chromium, type BrowserContext } from 'playwright'`
//
// Named imports: we pull out only the things we need from Playwright.
// `chromium` is the browser launcher (there's also `firefox`, `webkit`).
// `type BrowserContext` is a TypeScript-only import — it's the type of the
// object returned by launchPersistentContext(). The `type` keyword means
// this import disappears at compile time (no runtime effect).
//
// Python equivalent: from playwright.sync_api import chromium, BrowserContext
import { chromium, type BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logger';
import type { AppConfig } from '../config';

// The on-disk directory where Chromium stores its persistent profile.
// Cookies, localStorage, cache — all saved here between runs.
// Like pointing Chrome at a custom --user-data-dir.
const PROFILE_DIR  = path.resolve('./bgg-browser-profile');
const SCREENSHOT_DIR = path.resolve('./logs');
const BGG_BASE_URL = 'https://boardgamegeek.com';
const LOGIN_URL    = `${BGG_BASE_URL}/login`;

// ---- createBrowserContext ------------------------------------
//
// Launches Chromium and returns a BrowserContext (think: a single
// browser window with its own cookie jar and storage).
//
// `async function` means the function returns a Promise. The caller
// must `await` it to get the resolved value (the BrowserContext).
//
// Python async equivalent:
//   async def create_browser_context(config: AppConfig) -> BrowserContext:
//       ...
//       return await async_playwright().start().chromium.launch_persistent_context(...)
export async function createBrowserContext(config: AppConfig): Promise<BrowserContext> {
  log.info('Launching browser', { headless: config.digest.headless, profile: PROFILE_DIR });

  // launchPersistentContext() starts Chromium AND returns a BrowserContext
  // in one step. The first argument is the profile directory path.
  //
  // Unlike launchPersistentContext in Python (which uses with statements),
  // here we just await the call and get back the context directly.
  // We must call context.close() when done (done in index.ts's finally block).
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: config.digest.headless,
    viewport: { width: 1280, height: 800 },

    // We deliberately use Playwright's bundled Chromium (not system Chrome).
    // Bundled Chromium is more reliable with persistent contexts.
    // The userAgent must match the Chromium version so BGG/Cloudflare don't
    // flag the mismatch as a headless bot.
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  return context;
}

// ---- isLoggedIn (private helper) -----------------------------
//
// Checks whether we already have a valid BGG session by inspecting
// the cookie jar — no page navigation needed.
//
// Python Playwright equivalent:
//   cookies = context.cookies('https://boardgamegeek.com')
//   return any(c['name'] in AUTH_COOKIE_NAMES for c in cookies)
//
// The `Promise<boolean>` return type means: "this async function will
// eventually resolve to a boolean". In Python terms: Coroutine[bool].
async function isLoggedIn(context: BrowserContext): Promise<boolean> {
  // context.cookies() returns all cookies scoped to that URL.
  // Each cookie is an object with .name, .value, .domain, etc.
  // Python: context.cookies('https://boardgamegeek.com')
  const cookies = await context.cookies('https://boardgamegeek.com');

  // We check for any of several cookie names because BGG and Cloudflare
  // may set different ones across site versions. SessionID is the primary
  // session token; the others persist longer and confirm auth status.
  const AUTH_COOKIE_NAMES = ['SessionID', 'bggusername', 'bgg-uid'];

  // Array.find() returns the first matching element, or `undefined` if none.
  // The callback (c) => ... is an arrow function — like Python's lambda.
  // Python: next((c for c in cookies if c['name'] in AUTH_COOKIE_NAMES and c['value']), None)
  const authCookie = cookies.find(
    (c) => AUTH_COOKIE_NAMES.includes(c.name) && c.value && c.value.length > 0
  );

  if (authCookie) {
    log.info(`BGG auth cookie found (${authCookie.name}) — skipping login`);
    return true;
  }

  // .map() transforms each element — same as Python's list comprehension or map()
  // .join(', ') is Python's ', '.join(...)
  const cookieNames = cookies.map((c) => c.name).join(', ') || '(none)';
  log.info('No BGG auth cookies found — login required', { cookieNames });
  return false;
}

// ---- ensureLoggedIn ------------------------------------------
//
// Main export: call this once at startup to guarantee we have a valid
// session before navigating to protected pages.
//
// `Promise<void>` — like Python's `async def` that returns None.
export async function ensureLoggedIn(context: BrowserContext, config: AppConfig): Promise<void> {
  const alreadyIn = await isLoggedIn(context);

  // Early return — Python style. If we're logged in, nothing to do.
  if (alreadyIn) {
    return;
  }

  log.info('Not logged in — performing BGG login');

  // Open a new browser tab (Page = one browser tab).
  // In Python Playwright: page = context.new_page()
  const page = await context.newPage();

  // `try { ... } finally { ... }` guarantees page.close() runs even if
  // an error is thrown. Python equivalent:
  //   try:
  //       ...
  //   finally:
  //       page.close()
  try {
    // Navigate to the login page. waitUntil: 'domcontentloaded' means we
    // wait until the HTML is parsed, not until all images/scripts finish.
    // Python: page.goto(LOGIN_URL, wait_until='domcontentloaded')
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });

    // Underscore separators in numbers (45_000) are a readability feature —
    // same as 45000, but easier to read. Python supports this too (45_000).

    // If BGG redirected us away from /login, we're already logged in via
    // a cookie we didn't detect earlier. Nothing more to do.
    if (!page.url().includes('/login')) {
      log.info('BGG redirected away from /login — session is active, skipping form');
      return;
    }

    // ---- Fill the login form ----
    //
    // Playwright's getByRole() selects elements by their ARIA accessibility
    // role and name. This is more stable than CSS/XPath selectors because
    // it reflects how screen readers see the page, which BGG rarely changes.
    //
    // Python: page.get_by_role('textbox', name='Username').wait_for(timeout=20000)
    await page.getByRole('textbox', { name: 'Username' }).waitFor({ timeout: 20_000 });
    log.info('Login form found — filling credentials');

    // .fill() is equivalent to clearing the field and typing the value.
    // Python: page.get_by_role('textbox', name='Username').fill(config.bgg.username)
    await page.getByRole('textbox', { name: 'Username' }).fill(config.bgg.username);
    await page.getByRole('textbox', { name: 'Password' }).fill(config.bgg.password);

    // Small human-like delay before clicking. waitForTimeout() is a simple
    // sleep — it resolves after the given number of milliseconds.
    // Python: await asyncio.sleep(0.5)
    await page.waitForTimeout(500);

    // Click the submit button. BGG's form uses an Angular click handler rather
    // than a native form submit event, so pressing Enter doesn't work.
    // Python: page.get_by_role('button', name='Sign In').click()
    await page.getByRole('button', { name: 'Sign In' }).click();

    // Wait until the URL changes away from /login (any URL not containing /login).
    // The callback receives a URL object; we check its pathname.
    // Python: page.wait_for_url(lambda url: '/login' not in url, timeout=30000)
    await page.waitForURL(
      (url) => !url.pathname.includes('/login'),
      { timeout: 30_000 },
    );

    log.info('BGG login successful', { redirectedTo: page.url() });

  } catch (err) {
    // If login fails, save a screenshot so we can see what the page looked like.
    await saveDebugScreenshot(page, 'login-failure');

    // Re-throw with an enhanced error message. `String(err)` converts the error
    // to its string representation — same as Python's str(err).
    throw new Error(
      `BGG login failed: ${String(err)}\n` +
      `Screenshot saved to ./logs/ — check it to see what went wrong.\n` +
      `If the form loaded but credentials were rejected, verify config.json.\n` +
      `If Cloudflare is blocking, set headless: false in config.json for the first run.`
    );
  } finally {
    // Always close the login tab when done, whether login succeeded or failed.
    await page.close();
  }
}

// ---- saveDebugScreenshot (private helper) --------------------
//
// Saves a full-page screenshot to ./logs/ with a timestamp in the filename.
// Any error from screenshot() itself is swallowed — we don't want a
// screenshot failure to mask the real error we're trying to diagnose.
//
// `import('playwright').Page` is a *dynamic type import* — it pulls in
// the Page type without adding a top-level import. Used here because
// the Page type is already imported in other files and we just need it
// for this one private function's type annotation.
async function saveDebugScreenshot(page: import('playwright').Page, label: string): Promise<void> {
  try {
    if (!fs.existsSync(SCREENSHOT_DIR)) {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }

    // Replace colons and dots in the ISO timestamp so the filename is valid
    // on all filesystems (Windows doesn't allow ':' in filenames).
    // Python: ts = datetime.utcnow().isoformat().replace(':', '-').replace('.', '-')
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const screenshotPath = path.join(SCREENSHOT_DIR, `debug-${label}-${ts}.png`);

    // fullPage: true captures the entire scrollable page, not just the viewport.
    await page.screenshot({ path: screenshotPath, fullPage: true });
    log.info(`Debug screenshot saved: ${screenshotPath}`);
  } catch {
    // Intentionally empty catch — screenshot failure is non-fatal.
    // The real error will propagate from the calling catch block.
  }
}
