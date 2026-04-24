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
// decide what to highlight and how to order sections.
//
// PYTHON CONTEXT: `claude --print` is a CLI tool (Claude Code's headless
// mode) that reads a prompt from stdin and prints the response to stdout.
// We invoke it as a child process using Node.js's spawnSync() — similar
// to Python's subprocess.run() with capture_output=True.
//
// We write the prompt to a temp file and redirect it via stdin rather
// than passing it as a command-line argument, because shell argument
// length limits (typically 2MB on Linux) can be exceeded by large prompts.
// ============================================================

// `spawnSync` runs a child process synchronously (blocks until it exits).
// Python equivalent: subprocess.run(..., capture_output=True)
import { spawnSync } from 'child_process';

// `os` module — provides os.tmpdir() for the system's temp directory.
// Python: import tempfile; tempfile.gettempdir()
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';
import type { BggGeeklistItem } from './types';

// Claude Sonnet 4.6 has a 200K token context window (~800K chars).
// We set a generous limit so all subscriptions fit. The per-subscription
// item cap in config (maxNewItemsPerSubscription) controls depth per sub.
// At 57 subs × 15 items × ~700 chars ≈ 600K chars — right at this limit.
const MAX_CONTENT_CHARS = 600_000;

// ============================================================
// formatThreadContent — format thread articles as plain text
// ============================================================
//
// Converts a list of thread articles into a readable text block
// for inclusion in the Claude prompt. Claude gets plain text,
// not structured data, so readability matters more than parsability.
//
// PYTHON CONTEXT:
//   `Array<{ username: string; postdate: Date; ... }>` is TypeScript's
//   syntax for an array of inline anonymous object types. Python equivalent:
//   list[dict] or list[ArticleDict] with a TypedDict.
//
// The `export` keyword makes this available to index.ts which calls it
// after fetching each thread's articles.
export function formatThreadContent(
  threadSubject: string,
  // Inline object type for each article — no need for a named type here
  // since this shape is only used in this one function.
  articles: Array<{ username: string; postdate: Date; subject: string; body: string; link: string }>,
): string {
  // Build the output as an array of strings, then join them.
  // Python: lines = [f'=== Thread: {thread_subject} ===\n']
  const lines: string[] = [`=== Thread: ${threadSubject} ===\n`];

  // `for...of` iterates over array elements — same as Python's for loop
  for (const a of articles) {
    // .toLocaleDateString('en-US') formats as "1/15/2024" — human-readable
    // Python: a.postdate.strftime('%m/%d/%Y')
    const dateStr = a.postdate.toLocaleDateString('en-US');
    lines.push(`[Post by ${a.username} on ${dateStr}]`);
    if (a.subject) lines.push(`Subject: ${a.subject}`);  // Only add if non-empty
    lines.push(`Link: ${a.link}`);
    lines.push(a.body);
    lines.push('');  // Blank line between articles for readability
  }

  // Array.join('\n') concatenates with newlines — Python: '\n'.join(lines)
  return lines.join('\n');
}

// ============================================================
// formatGeeklistContent — format geeklist items as plain text
// ============================================================
//
// Same pattern as formatThreadContent but for geeklists.
// Includes each item's comments indented below the item.
export function formatGeeklistContent(
  geeklistTitle: string,
  items: BggGeeklistItem[],
): string {
  const lines: string[] = [`=== Geeklist: ${geeklistTitle} ===\n`];

  for (const item of items) {
    const dateStr = item.postdate.toLocaleDateString('en-US');
    // `—` is an em-dash character used for visual separation in the output.
    lines.push(`[Item by ${item.username} on ${dateStr}] — ${item.objectName}`);
    lines.push(`Link: ${item.link}`);
    if (item.body) lines.push(item.body);

    // Indent comments below their parent item
    for (const c of item.comments) {
      const cd = c.date.toLocaleDateString('en-US');
      // `↳` is a visual cue that this is a reply/comment
      lines.push(`  ↳ Comment by ${c.username} on ${cd}: ${c.body}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================
// buildBatchPrompt — construct the full Claude prompt
// ============================================================
//
// Combines all subscription content sections and the user's interests
// file into a single large prompt string. This is private (not exported)
// — only callClaudeHeadless() uses it.
//
// `sections: Array<{ title: string; url: string; content: string }>`:
//   An array of objects, each with three string fields. This is the
//   type coming out of formatThreadContent / formatGeeklistContent.
function buildBatchPrompt(
  sections: Array<{ title: string; url: string; content: string }>,
  interests: string,
): string {
  // Build a labeled block for each subscription.
  // Array.map() transforms each element — Python: [f'...' for s in sections]
  // The callback uses destructuring: `({ title, url, content })` unpacks the object.
  // Python: for title, url, content in ((s['title'], s['url'], s['content']) for s in sections):
  const contentBlocks = sections
    .map(({ title, url, content }) =>
      `### SUBSCRIPTION: ${title}\nURL: ${url}\n\n${content}`,
    )
    // Join all blocks with a horizontal rule separator
    .join('\n\n---\n\n');

  // Personalization context for Claude. If interests.md is empty, we
  // fall back to "summarize all content equally".
  const interestsSection = interests
    ? `Here is what I care about — use this to decide what to highlight and how to order sections:\n\n${interests}`
    : 'No specific interests configured — summarize all content equally.';

  // Template literal with ${} interpolation — Python f-string equivalent.
  // `sections.length !== 1 ? 's' : ''` is a ternary for grammatical pluralization.
  // Python: 's' if len(sections) != 1 else ''
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
  // `.slice(0, MAX_CONTENT_CHARS)` — hard cap on content length to stay within
  // Claude's context window. Python: content_blocks[:MAX_CONTENT_CHARS]
  // The per-subscription item cap (maxNewItemsPerSubscription) is the first
  // line of defense; this slice is the safety net.
}

// ============================================================
// callClaudeHeadless — invoke `claude --print` as a subprocess
// ============================================================
//
// Writes the prompt to a temp file and pipes it to claude's stdin.
// Using a temp file (not a command-line arg) because shell argument
// length limits (~2MB) can be exceeded by large prompts.
//
// PYTHON CONTEXT equivalent:
//   import subprocess, tempfile, os
//
//   def call_claude_headless(prompt: str) -> str:
//       with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
//           f.write(prompt)
//           tmp_path = f.name
//       try:
//           result = subprocess.run(
//               f'claude --print < "{tmp_path}"',
//               shell=True, capture_output=True, text=True, timeout=600
//           )
//           if result.returncode != 0:
//               raise RuntimeError(f'claude exited {result.returncode}: {result.stderr[:500]}')
//           return result.stdout.strip()
//       finally:
//           os.unlink(tmp_path)
function callClaudeHeadless(prompt: string): string {
  // os.tmpdir() returns the system's temp directory (/tmp on Linux/Mac, %TEMP% on Windows)
  // `Date.now()` returns milliseconds since epoch — used to make the filename unique.
  // Python: f'/tmp/bgg-digest-prompt-{int(time.time() * 1000)}.txt'
  const tmpFile = path.join(os.tmpdir(), `bgg-digest-prompt-${Date.now()}.txt`);

  // `try { ... } finally { ... }` — the finally block runs whether or not
  // an error was thrown in the try block. Used here to clean up the temp file.
  // Python: try: ... finally: os.unlink(tmp_path)
  try {
    // Write the prompt to the temp file synchronously (blocks until complete).
    // Python: Path(tmp_file).write_text(prompt, encoding='utf-8')
    fs.writeFileSync(tmpFile, prompt, 'utf-8');
    log.debug('Calling claude CLI in headless mode', { promptLength: prompt.length });

    // spawnSync() runs a command synchronously and waits for it to exit.
    // The command uses shell I/O redirection (`< "tmpFile"`) to pipe the
    // file into claude's stdin — this bypasses shell argument length limits.
    //
    // Options:
    //   shell: true     — run via /bin/sh so the < redirect works
    //   encoding: 'utf-8' — return stdout/stderr as strings (not Buffers)
    //   timeout: 600000 — 10 minutes max for large batches with many subscriptions
    //   maxBuffer: 20MB — cap the stdout buffer so very long responses don't OOM
    //
    // Python: subprocess.run(f'claude --print < "{tmp_file}"', shell=True,
    //                        capture_output=True, text=True, timeout=600)
    const result = spawnSync(
      `claude --print < "${tmpFile}"`,
      {
        shell: true,
        encoding: 'utf-8',
        timeout: 10 * 60 * 1000,    // 10 minutes in milliseconds
        maxBuffer: 20 * 1024 * 1024, // 20 MB max output buffer
      },
    );

    // `result.error` is set if spawnSync itself failed (e.g., command not found).
    // Different from a non-zero exit code — this is a spawn-level error.
    // Python: result.returncode vs subprocess.SubprocessError
    if (result.error) throw result.error;

    if (result.status !== 0) {
      // result.status is the process exit code. 0 = success, anything else = failure.
      // Python: result.returncode
      // result.stderr?.slice(0, 500) — optional chaining + slice for the error preview.
      // Python: (result.stderr or '')[:500]
      const stderr = result.stderr?.slice(0, 500) ?? '';
      throw new Error(`claude CLI exited with code ${result.status}: ${stderr}`);
    }

    // result.stdout is the captured stdout as a string.
    // .trim() strips leading/trailing whitespace — Python: result.stdout.strip()
    const output = result.stdout?.trim() ?? '';
    if (!output) throw new Error('claude CLI returned empty output');

    log.debug('Claude CLI response received', { responseLength: output.length });
    return output;

  } finally {
    // Always delete the temp file, even if an error occurred.
    // fs.unlink() is async (callback-based). The empty callback `() => undefined`
    // means "don't wait for completion, don't care about errors".
    // Python: os.unlink(tmp_path)  (but in a finally block it's always synchronous)
    fs.unlink(tmpFile, () => undefined);
  }
}

// ============================================================
// summarizeAllContent — main export
// ============================================================
//
// Called from index.ts after all subscription content has been fetched.
// Builds the prompt, runs claude, and returns the markdown digest body.
//
// On error (network timeout, claude not installed, etc.), returns a
// fallback string with raw content excerpts so the user still gets
// something useful even if Claude can't be reached.
export function summarizeAllContent(
  sections: Array<{ title: string; url: string; content: string }>,
  interests: string,
): string {
  // Early exit — if there's nothing to summarize, return a short message.
  if (sections.length === 0) {
    return '*No outstanding subscription activity found.*';
  }

  const prompt = buildBatchPrompt(sections, interests);

  // try/catch wraps the Claude call so a single failure doesn't crash the
  // whole digest — we fall back to raw content excerpts instead.
  try {
    return callClaudeHeadless(prompt);
  } catch (err) {
    log.error('Claude summarization failed', { err: String(err) });

    // Fallback: return the first 500 chars of each subscription's content
    // so the user sees SOMETHING even without Claude's summary.
    // Array.map().join() builds the fallback string.
    return (
      `*⚠️ Summarization failed — raw content excerpt:*\n\n` +
      sections.map(({ title, url, content }) =>
        `### ${title}\n${url}\n\n${content.slice(0, 500)}\n\n---`
      ).join('\n\n')
    );
  }
}
