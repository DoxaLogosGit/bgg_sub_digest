// ============================================================
// page-content.ts — scrape blog posts and file pages from BGG HTML
//
// BGG XML API has no endpoint for blog posts or file pages, but the user
// is subscribed to them and expects to see what's new — not just a "go
// click this link" stub. We render the page in Playwright and pull the
// post body + comments from the DOM.
//
// DOM landmarks (verified against the live site on 2026-04-28):
//   Blog post:  <h1 class="blog-post__headline">  + <div class="blog-post__body">
//   File page:  <h1 class="caption-title">        + <article class="post">…</article>
//                                                   inside an article: <div class="post-body">
//   Comments on either: <article class="post">    with <div class="post-body"> body
// ============================================================

import type { Page } from 'playwright';
import { log } from '../logger';

export interface FetchedPostComment {
  author: string;     // human-readable display name when available, else handle
  dateText: string;   // BGG renders "11 hours ago" / "Apr 24" — we keep the rendered text
  body: string;       // post-body text, whitespace-collapsed and truncated
}

export interface FetchedPageContent {
  title: string;
  body: string;                  // main blog post body (empty for filepages)
  comments: FetchedPostComment[]; // most-recent first if BGG renders that way; we don't re-sort
}

const PAGE_RENDER_DELAY_MS = 2_500;
const COMMENT_BODY_MAX     = 800;
const POST_BODY_MAX        = 4_000;

// fetchPageContent — open the URL in Playwright and extract structured content.
// Returns null on navigation failure so callers can degrade gracefully.
export async function fetchPageContent(url: string, page: Page): Promise<FetchedPageContent | null> {
  log.debug('Fetching BGG HTML page', { url });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (err) {
    log.warn('fetchPageContent: navigation failed', { url, err: String(err) });
    return null;
  }

  // BGG's pages are Angular SPAs — content renders after DOMContentLoaded.
  // A short delay is more reliable than waitForSelector across page types
  // (blog vs filepage vs other), since the right selector varies.
  await page.waitForTimeout(PAGE_RENDER_DELAY_MS);

  const dump = await page.evaluate(`(() => {
    function clean(s) { return (s || '').replace(/\\s+/g, ' ').trim(); }
    function truncate(s, max) { return s.length > max ? s.slice(0, max) + '…' : s; }

    var title = '';
    var titleEl =
      document.querySelector('.blog-post__headline') ||
      document.querySelector('h1.caption-title') ||
      document.querySelector('article h1');
    if (titleEl) title = clean(titleEl.textContent || '');

    var body = '';
    var bodyEl = document.querySelector('.blog-post__body');
    if (bodyEl) body = clean(bodyEl.textContent || '');

    // Comments live in <article class="post"> blocks. Each has:
    //   - a header line with author name, handle, and rendered date
    //   - a <div class="post-body"> with the comment text
    //
    // We don't have great selectors for author/date individually — they're
    // styled inline with the avatar — so we fall back to grabbing the whole
    // header strip's text content and letting Claude make sense of it.
    var comments = [];
    var posts = Array.from(document.querySelectorAll('article.post'));
    for (var i = 0; i < posts.length; i++) {
      var post = posts[i];
      var bodyDiv = post.querySelector('.post-body');
      var bodyText = bodyDiv ? clean(bodyDiv.textContent || '') : '';
      if (bodyText.length === 0) continue;

      // Header text = post element's full text MINUS the body text.
      var fullText = clean(post.textContent || '');
      var headerText = fullText;
      var bodyIdx = fullText.indexOf(bodyText);
      if (bodyIdx >= 0) headerText = fullText.slice(0, bodyIdx).trim();

      // Heuristics for author / date inside the header.
      // Header looks like: "User actions menu Display Name @handle @handle Apr 24Full Date"
      // We strip the boilerplate "User actions menu" and dedup the @handle.
      headerText = headerText.replace(/^User actions menu\\s*/, '');
      // The first @handle and the second are usually identical — collapse them.
      headerText = headerText.replace(/(@\\S+)\\s+\\1/, '$1');
      // Remove the "Full Date" tooltip suffix.
      headerText = headerText.replace(/Full Date\\s*$/, '').trim();

      // Rough split: everything before the @handle is the display name,
      // everything between handle and the date suffix is the date text.
      var m = headerText.match(/^(.*?)\\s+(@\\S+)\\s+(.+)$/);
      var author = m ? clean(m[1] + ' (' + m[2] + ')') : headerText;
      var dateText = m ? clean(m[3]) : '';

      comments.push({
        author: author,
        dateText: dateText,
        body: bodyText
      });
    }

    return { title: title, body: body, comments: comments };
  })()`) as { title: string; body: string; comments: { author: string; dateText: string; body: string }[] };

  return {
    title:    dump.title || url,
    body:     dump.body.length > POST_BODY_MAX ? dump.body.slice(0, POST_BODY_MAX) + '…' : dump.body,
    comments: dump.comments.map((c) => ({
      author:   c.author,
      dateText: c.dateText,
      body:     c.body.length > COMMENT_BODY_MAX ? c.body.slice(0, COMMENT_BODY_MAX) + '…' : c.body,
    })),
  };
}

// formatPageContent — render a FetchedPageContent into the same plain-text
// layout used by formatThreadContent / formatGeeklistContent so Claude reads
// it consistently across subscription types.
export function formatPageContent(kind: string, sourceUrl: string, content: FetchedPageContent): string {
  const lines: string[] = [`=== ${kind}: ${content.title} ===`, `Source: ${sourceUrl}`, ''];
  if (content.body) {
    lines.push('--- Post body ---');
    lines.push(content.body);
    lines.push('');
  }
  if (content.comments.length > 0) {
    lines.push(`--- Comments (${content.comments.length}) ---`);
    for (const c of content.comments) {
      lines.push(`[${c.author}${c.dateText ? ' · ' + c.dateText : ''}]`);
      lines.push(c.body);
      lines.push('');
    }
  }
  return lines.join('\n');
}
