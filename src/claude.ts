// ============================================================
// claude.ts — summarize all outstanding BGG activity in one call
//
// We collect formatted content from every outstanding subscription,
// combine it into a single prompt, and call `claude --print` once.
// Claude produces the complete digest body — sections, highlights,
// and ordering — based on the user's interests file.
//
// The interests file (default: ./interests.md) is a plain-text
// description of what the user cares about. Claude uses it to
// decide what to highlight and how to order sections. No structured
// config arrays needed — just write naturally.
// ============================================================

import { spawnSync } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';
import type { BggGeeklistItem } from './types';

// Claude Sonnet 4.6 has a 200K token context window (~800K chars).
// We set a generous limit so all subscriptions fit. The per-subscription
// item cap in config (maxNewItemsPerSubscription) controls depth per sub.
const MAX_CONTENT_CHARS = 600_000;

// Format thread articles as readable text for the prompt.
export function formatThreadContent(
  threadSubject: string,
  articles: Array<{ username: string; postdate: Date; subject: string; body: string; link: string }>,
): string {
  const lines: string[] = [`=== Thread: ${threadSubject} ===\n`];
  for (const a of articles) {
    const dateStr = a.postdate.toLocaleDateString('en-US');
    lines.push(`[Post by ${a.username} on ${dateStr}]`);
    if (a.subject) lines.push(`Subject: ${a.subject}`);
    lines.push(`Link: ${a.link}`);
    lines.push(a.body);
    lines.push('');
  }
  return lines.join('\n');
}

// Format geeklist items as readable text for the prompt.
export function formatGeeklistContent(
  geeklistTitle: string,
  items: BggGeeklistItem[],
): string {
  const lines: string[] = [`=== Geeklist: ${geeklistTitle} ===\n`];
  for (const item of items) {
    const dateStr = item.postdate.toLocaleDateString('en-US');
    lines.push(`[Item by ${item.username} on ${dateStr}] — ${item.objectName}`);
    lines.push(`Link: ${item.link}`);
    if (item.body) lines.push(item.body);
    for (const c of item.comments) {
      const cd = c.date.toLocaleDateString('en-US');
      lines.push(`  ↳ Comment by ${c.username} on ${cd}: ${c.body}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// Build the single prompt that covers all outstanding subscriptions.
function buildBatchPrompt(
  sections: Array<{ title: string; url: string; content: string }>,
  interests: string,
): string {
  const contentBlocks = sections
    .map(({ title, url, content }) =>
      `### SUBSCRIPTION: ${title}\nURL: ${url}\n\n${content}`,
    )
    .join('\n\n---\n\n');

  const interestsSection = interests
    ? `Here is what I care about — use this to decide what to highlight and how to order sections:\n\n${interests}`
    : 'No specific interests configured — summarize all content equally.';

  return `You are building a BGG (BoardGameGeek) subscription digest.

${interestsSection}

Below is ALL outstanding (unread) activity from ${sections.length} BGG subscription${sections.length !== 1 ? 's' : ''}. These are notifications BGG has flagged as unread.

For EACH subscription, write a section in this exact markdown format:

### [Subscription Title](URL)

**Summary:** 2–4 sentences on what's new and the overall tone.

**New Activity:**
- Bullet per notable item (max 8). Include author, brief description, and link where available. Mark items matching my interests with ⭐.

**Topics Mentioned:** comma-separated list of matched interests, or "none"

---

Order the sections with the most relevant-to-my-interests subscriptions first.
Write a brief "## ⭐ Highlights" section at the very top listing the ⭐ items across all subscriptions before diving into individual sections.
If a subscription has no meaningful content to summarize, skip it entirely.

[CONTENT BEGINS]

${contentBlocks.slice(0, MAX_CONTENT_CHARS)}`;
}

// Run claude --print with the prompt via a temp file (avoids shell-arg length limits).
function callClaudeHeadless(prompt: string): string {
  const tmpFile = path.join(os.tmpdir(), `bgg-digest-prompt-${Date.now()}.txt`);

  try {
    fs.writeFileSync(tmpFile, prompt, 'utf-8');
    log.debug('Calling claude CLI in headless mode', { promptLength: prompt.length });

    const result = spawnSync(
      `claude --print < "${tmpFile}"`,
      {
        shell: true,
        encoding: 'utf-8',
        timeout: 10 * 60 * 1000, // 10 min for large batches
        maxBuffer: 20 * 1024 * 1024,
      },
    );

    if (result.error) throw result.error;

    if (result.status !== 0) {
      const stderr = result.stderr?.slice(0, 500) ?? '';
      throw new Error(`claude CLI exited with code ${result.status}: ${stderr}`);
    }

    const output = result.stdout?.trim() ?? '';
    if (!output) throw new Error('claude CLI returned empty output');

    log.debug('Claude CLI response received', { responseLength: output.length });
    return output;

  } finally {
    fs.unlink(tmpFile, () => undefined);
  }
}

// Main export: summarize all subscriptions in one Claude call.
// Returns the complete markdown digest body produced by Claude.
export function summarizeAllContent(
  sections: Array<{ title: string; url: string; content: string }>,
  interests: string,
): string {
  if (sections.length === 0) {
    return '*No outstanding subscription activity found.*';
  }

  const prompt = buildBatchPrompt(sections, interests);

  try {
    return callClaudeHeadless(prompt);
  } catch (err) {
    log.error('Claude summarization failed', { err: String(err) });
    return (
      `*⚠️ Summarization failed — raw content excerpt:*\n\n` +
      sections.map(({ title, url, content }) =>
        `### ${title}\n${url}\n\n${content.slice(0, 500)}\n\n---`
      ).join('\n\n')
    );
  }
}
