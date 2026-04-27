// ============================================================
// claude.ts — write subscription data files and invoke Claude to produce the digest
//
// ARCHITECTURE (file-based, replaces the old single-prompt approach):
//
//   1. For each outstanding BGG subscription, format its content and
//      write it to ./digest-data/[type]-[id].md
//
//   2. Write a manifest.json listing all subscription files with metadata.
//
//   3. Launch `claude --model opus --dangerously-skip-permissions --print --output-format json`
//      with a prompt that tells it to read the manifest then each file.
//      Claude uses its built-in Read tool to read files selectively.
//
//   4. Parse the JSON response to extract the digest body AND token usage stats.
//
// WHY file-based instead of one big prompt:
//   - High-volume subscriptions (e.g. SGOYT with 400+ items behind) get their
//     own file — Claude reads it and summarizes by theme, rather than us trying
//     to cram everything into a 600K-char context window.
//   - Claude decides which files to read in depth vs. skim based on your interests.
//   - The JSON output format gives us exact token usage + cost for the digest footer.
//
// PYTHON CONTEXT: `claude --dangerously-skip-permissions --print` is Claude
// Code's headless mode. It reads a prompt from stdin, uses tools (like the
// Read tool to read files) without permission prompts, and prints output.
// We pass `--output-format json` to get a single JSON object with the full
// response plus token usage and cost statistics.
// We invoke it as a child process using spawnSync() — like Python's subprocess.run()
// with capture_output=True.
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

// ============================================================
// formatThreadContent — format thread articles as plain text
// ============================================================
//
// Converts a list of thread articles into a readable text block
// for inclusion in the subscription data file. Claude gets plain text,
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
//
// `notificationDate` — the earliest notification date scraped from BGG's
// subscription page. Comments newer than this date are labeled "[NEW]" so
// Claude knows which discussion was actually added since the last visit.
// If null (we couldn't parse a date), all comments are shown without labels.
//
// Python equivalent signature:
//   def format_geeklist_content(
//       title: str,
//       items: list[BggGeeklistItem],
//       notification_date: Optional[datetime] = None,
//   ) -> str:
export function formatGeeklistContent(
  geeklistTitle: string,
  items: BggGeeklistItem[],
  notificationDate: Date | null = null,  // `= null` is the default parameter value
): string {
  const lines: string[] = [`=== Geeklist: ${geeklistTitle} ===\n`];

  for (const item of items) {
    const dateStr = item.postdate.toLocaleDateString('en-US');

    // The last-activity date — whichever is later: postdate or editdate.
    // If editdate > postdate, the item was edited or had comments added.
    // Python: last_activity = max(item.postdate, item.editdate)
    const lastActivity = item.editdate > item.postdate ? item.editdate : item.postdate;
    const activityStr  = lastActivity.toLocaleDateString('en-US');

    // Mark the item as NEW if it was posted after the notification cutoff,
    // meaning the item itself was added to the geeklist since the last visit.
    // `notificationDate !== null && item.postdate > notificationDate`:
    //   — `!== null` checks notificationDate exists (not null or undefined)
    //   — `&&` short-circuits: if left side is false, right side is not evaluated
    //   Python: notification_date and item.postdate > notification_date
    const itemIsNew = notificationDate !== null && item.postdate > notificationDate;
    const newTag    = itemIsNew ? ' [NEW ITEM]' : '';

    // `—` is an em-dash character used for visual separation in the output.
    lines.push(`[Item by ${item.username} posted ${dateStr}, last activity ${activityStr}]${newTag} — ${item.objectName}`);
    lines.push(`Link: ${item.link}`);
    if (item.body) lines.push(item.body);

    // ---- Filter and label comments ----
    //
    // Sort comments newest-first so if we must cap, we keep the most recent.
    // `[...item.comments]` creates a shallow copy before sorting — we never
    // mutate the original array. Python: sorted(item.comments, key=..., reverse=True)
    const sortedComments = [...item.comments]
      .sort((a, b) => b.date.getTime() - a.date.getTime())  // Newest first
      .slice(0, 10);  // Cap at 10 per item — Python: [:10]

    for (const c of sortedComments) {
      const cd = c.date.toLocaleDateString('en-US');
      // Label comments that are newer than the notification cutoff as "[NEW]".
      // These are comments that were added since the user's last visit.
      // Python: '[NEW] ' if notification_date and c.date > notification_date else ''
      const commentTag = (notificationDate !== null && c.date > notificationDate) ? ' [NEW]' : '';
      // `↳` is a visual cue that this is a reply/comment
      lines.push(`  ↳ Comment by ${c.username} on ${cd}${commentTag}: ${c.body}`);
    }

    // Note if we omitted older comments due to the cap
    if (item.comments.length > 10) {
      lines.push(`  ↳ (${item.comments.length - 10} older comments not shown)`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================
// ManifestEntry — metadata for one subscription's data file
// ============================================================
//
// PYTHON CONTEXT: `interface` is TypeScript's equivalent of a TypedDict
// or frozen @dataclass — just a shape description for the type checker,
// no runtime code generated. The `export` keyword makes it importable
// by index.ts.
//
// Python equivalent:
//   from typing import TypedDict, Optional, Literal
//   class ManifestEntry(TypedDict):
//       subscription_id: int
//       type: Literal['thread', 'geeklist', 'unknown']
//       title: str
//       url: str
//       file_path: str
//       item_count: int
//       notification_date: Optional[str]
export interface ManifestEntry {
  // BGG's internal numeric ID for this subscription
  subscriptionId: number;

  // 'thread' for forum threads, 'geeklist' for community curated lists
  type: 'thread' | 'geeklist' | 'unknown';

  // Human-readable title (from BGG's notification page or API)
  title: string;

  // Canonical URL to this subscription's content page on BGG
  url: string;

  // Absolute filesystem path to the subscription's data file.
  // Claude reads this path using its Read tool.
  filePath: string;

  // How many items (articles / geeklist entries) are in the data file.
  // This is what we actually fetched — may differ from unreadCount.
  itemCount: number;

  // BGG's advertised count of unread posts/items/comments for this subscription,
  // parsed from the notification row summary text ("3 more replies", "12 new items").
  // 0 means we couldn't parse it — not the same as nothing new.
  // Geeklists may report separate item + comment counts which we sum.
  unreadCount: number;

  // ISO 8601 timestamp: when BGG last marked this subscription as read.
  // null if we couldn't parse a date from the notification row text.
  // Python: Optional[str]
  notificationDate: string | null;
}

// ============================================================
// DigestResult — return type of runClaudeDigest
// ============================================================
//
// Bundles Claude's markdown response with token usage stats parsed
// from the --output-format json output.
//
// PYTHON CONTEXT: `interface` here is like a TypedDict for a function's
// return value. The caller (index.ts) uses these fields to build the
// token usage footer in the digest.
export interface DigestResult {
  body: string;          // Claude's full markdown digest text
  inputTokens: number;   // Total context tokens (prompt + cache hits + cache creation)
  outputTokens: number;  // Tokens in Claude's response
  costUsd: number;       // Estimated cost in USD (from total_cost_usd in JSON output)
  durationMs: number;    // Wall-clock time for the full Claude call
}

// ============================================================
// writeSubscriptionFile — write one subscription's content to disk
// ============================================================
//
// Creates ./digest-data/[type]-[id].md with the formatted text content.
// Returns the absolute path to the file that was written.
// The file is overwritten if it already exists (each run is fresh).
//
// PYTHON CONTEXT equivalent:
//   def write_subscription_file(sub: dict, content: str, digest_data_dir: str) -> str:
//       os.makedirs(digest_data_dir, exist_ok=True)
//       file_path = os.path.join(digest_data_dir, f"{sub['type']}-{sub['id']}.md")
//       Path(file_path).write_text(content, encoding='utf-8')
//       return file_path
export function writeSubscriptionFile(
  // Inline type: only needs type and id from the full BggSubscription object.
  // TypeScript structural typing means any object with these two fields will work.
  sub: { type: string; id: number },
  content: string,
  digestDataDir: string,
): string {
  // Create the directory if it doesn't exist.
  // { recursive: true } = like mkdir -p — no error if already exists.
  // Python: os.makedirs(digest_data_dir, exist_ok=True)
  if (!fs.existsSync(digestDataDir)) {
    fs.mkdirSync(digestDataDir, { recursive: true });
  }

  // Build the filename: "geeklist-123456.md" or "thread-789012.md"
  // Template literal: `${sub.type}-${sub.id}.md`
  // Python: f"{sub['type']}-{sub['id']}.md"
  const fileName = `${sub.type}-${sub.id}.md`;
  const filePath = path.join(digestDataDir, fileName);

  // Write (overwrite) the file synchronously.
  // Python: Path(file_path).write_text(content, encoding='utf-8')
  fs.writeFileSync(filePath, content, 'utf-8');
  log.debug('Subscription file written', { filePath, bytes: content.length });
  return filePath;
}

// ============================================================
// writeManifest — write manifest.json listing all subscription files
// ============================================================
//
// The manifest is Claude's index. It reads this first to discover
// what files are available, how many items each has, and when each
// subscription was last visited — giving it enough context to prioritize
// which files to read in depth vs. skim based on the interests file.
//
// Returns the absolute path to the manifest file.
//
// PYTHON CONTEXT:
//   def write_manifest(entries: list[ManifestEntry], digest_data_dir: str) -> str:
//       manifest_path = os.path.join(digest_data_dir, 'manifest.json')
//       Path(manifest_path).write_text(json.dumps(entries, indent=2), encoding='utf-8')
//       return manifest_path
export function writeManifest(entries: ManifestEntry[], digestDataDir: string): string {
  const manifestPath = path.join(digestDataDir, 'manifest.json');

  // JSON.stringify(value, null, 2):
  //   - value: the data to serialize
  //   - null: no custom replacer function
  //   - 2: indent with 2 spaces (human-readable)
  // Python: json.dumps(entries, indent=2)
  fs.writeFileSync(manifestPath, JSON.stringify(entries, null, 2), 'utf-8');
  log.debug('Manifest written', { manifestPath, subscriptions: entries.length });
  return manifestPath;
}

// ============================================================
// buildDigestPrompt — construct the task instructions for Claude
// ============================================================
//
// Private function (not exported) — only runClaudeDigest calls this.
// The prompt tells Claude:
//   1. What to do (build a BGG digest)
//   2. Where the data is (manifest path — exact absolute path)
//   3. How to format the output (section structure)
//   4. What to do for high-volume subscriptions (summarize by theme)
//   5. What the user cares about (interests file content)
//
// We give Claude explicit instructions to read ONLY the listed files —
// not to explore the filesystem — since it has full FS access via
// --dangerously-skip-permissions.
function buildDigestPrompt(manifestPath: string, interests: string): string {
  // If the user has an interests.md file, include it as personalization context.
  // If not, Claude summarizes everything equally.
  // Python: interests_section = f"..." if interests else "..."
  const interestsSection = interests
    ? `Here is what I care about — use this to prioritize, highlight, and order sections:\n\n${interests}`
    : 'No specific interests configured — summarize all content equally.';

  // Template literal (Python f-string) for the full prompt.
  // Note: we pass the exact absolute path for the manifest so Claude can find it
  // regardless of its working directory.
  return `You are building a BGG (BoardGameGeek) subscription digest.

${interestsSection}

Read the manifest file at this exact path: ${manifestPath}

The manifest is a JSON array where each entry describes one subscription:
  - "title": subscription name
  - "url": BGG URL for this subscription
  - "type": "thread" (forum thread) or "geeklist" (community curated list)
  - "filePath": absolute path to the subscription's data file — read this with your Read tool
  - "itemCount": how many items are in the data file
  - "unreadCount": BGG's reported number of unread posts/items/comments (0 = unknown); treat this as ground truth for how much new activity exists
  - "notificationDate": when this subscription was last visited (ISO timestamp or null)

For EACH subscription in the manifest:
1. Read the subscription's data file (use the "filePath" value from the manifest)
2. Write a section in this exact markdown format:

### [Subscription Title](URL)

**Summary:** 2–4 sentences on what's new and the overall tone.

**New Activity:**
- Bullet per notable item (max 8). Include author, brief description, and link where available. Mark items matching my interests with ⭐.

**Topics Mentioned:** comma-separated list of matched interests, or "none"

---

Ordering and structure rules:
- Order sections with the most relevant-to-my-interests subscriptions FIRST
- Write a "## ⭐ Highlights" section at the very top, listing ⭐ items across ALL subscriptions before the individual sections
- For high-volume subscriptions (itemCount > 30), summarize activity by THEME rather than listing individual items — e.g. "15 posts discussed solo experiences with Wingspan" rather than 15 separate bullets
- Skip subscriptions with no meaningful content to report
- Read ONLY the files listed in the manifest — do not explore the rest of the filesystem`;
}

// ============================================================
// runClaudeDigest — launch claude with file access and parse the result
// ============================================================
//
// Writes the prompt to a temp file, launches:
//   claude --dangerously-skip-permissions --print --output-format json
// which reads the manifest and subscription files autonomously, then
// parses the JSON response to extract the digest text and token stats.
//
// The JSON response structure (verified empirically):
//   {
//     "type": "result",
//     "result": "...markdown digest...",
//     "total_cost_usd": 0.046,
//     "duration_ms": 45000,
//     "usage": {
//       "input_tokens": 3,
//       "cache_creation_input_tokens": 9095,
//       "cache_read_input_tokens": 33826,
//       "output_tokens": 136
//     }
//   }
//
// PYTHON CONTEXT equivalent:
//   def run_claude_digest(manifest_path: str, interests: str) -> DigestResult:
//       prompt = build_digest_prompt(manifest_path, interests)
//       with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
//           f.write(prompt)
//           tmp = f.name
//       try:
//           result = subprocess.run(
//               f'claude --dangerously-skip-permissions --print --output-format json < "{tmp}"',
//               shell=True, capture_output=True, text=True, timeout=1200
//           )
//           parsed = json.loads(result.stdout)
//           usage = parsed.get('usage', {})
//           return DigestResult(body=parsed['result'], ...)
//       finally:
//           os.unlink(tmp)
export function runClaudeDigest(manifestPath: string, interests: string): DigestResult {
  const prompt = buildDigestPrompt(manifestPath, interests);

  // Write prompt to a temp file — avoids shell argument length limits.
  // Python: with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
  const tmpFile = path.join(os.tmpdir(), `bgg-digest-prompt-${Date.now()}.txt`);

  // `try { ... } finally { ... }` ensures the temp file is always deleted.
  // Python: try: ... finally: os.unlink(tmp_file)
  try {
    fs.writeFileSync(tmpFile, prompt, 'utf-8');
    log.debug('Launching claude with --dangerously-skip-permissions', {
      manifestPath,
      promptLength: prompt.length,
    });

    // Launch claude in headless mode with:
    //   --model opus                    : use Claude Opus for higher quality digest writing
    //   --dangerously-skip-permissions  : no approval prompts for file reads
    //   --print                         : read from stdin, print result to stdout
    //   --output-format json            : return a JSON object with result + usage stats
    //
    // Timeout is 20 minutes — file reading adds multiple round-trips vs. a single prompt.
    // Python: subprocess.run(..., shell=True, capture_output=True, text=True, timeout=1200)
    const result = spawnSync(
      `claude --model opus --dangerously-skip-permissions --print --output-format json < "${tmpFile}"`,
      {
        shell:     true,
        encoding:  'utf-8',
        timeout:   20 * 60 * 1000,    // 20 minutes in milliseconds
        maxBuffer: 20 * 1024 * 1024,  // 20 MB max output buffer
      },
    );

    // `result.error` is set if spawnSync itself failed (e.g. command not found).
    // This is different from a non-zero exit code — it's a Node.js-level spawn error.
    // Python: subprocess.SubprocessError vs. result.returncode != 0
    if (result.error) throw result.error;

    if (result.status !== 0) {
      // Non-zero exit = claude CLI reported an error.
      // result.stderr?.slice(0, 500): first 500 chars of stderr for the error message.
      // Python: (result.stderr or '')[:500]
      const stderr = result.stderr?.slice(0, 500) ?? '';
      throw new Error(`claude CLI exited with code ${result.status}: ${stderr}`);
    }

    // .trim() strips leading/trailing whitespace — Python: result.stdout.strip()
    const rawOutput = result.stdout?.trim() ?? '';
    if (!rawOutput) throw new Error('claude CLI returned empty output');

    log.debug('Claude file-based digest received', { outputLength: rawOutput.length });

    // ---- Parse the JSON response ----
    //
    // Declare the expected shape using a TypeScript inline type.
    // `?` suffix means the field may be absent — optional chaining (?.) handles that below.
    // Python equivalent type hints:
    //   result: Optional[str]
    //   total_cost_usd: Optional[float]
    //   duration_ms: Optional[int]
    //   usage: Optional[dict]
    let parsed: {
      result?: string;
      total_cost_usd?: number;
      duration_ms?: number;
      usage?: {
        input_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
        output_tokens?: number;
      };
    };

    try {
      // JSON.parse() converts a JSON string to a JavaScript object.
      // Python: json.loads(raw_output)
      // `as { ... }` is a TypeScript type assertion — tells the compiler what shape to expect.
      // At runtime it's just JSON.parse() — no actual validation.
      parsed = JSON.parse(rawOutput) as typeof parsed;
    } catch {
      // JSON parse failed — shouldn't happen with --output-format json, but be safe.
      // Fall through with raw text and zero token stats.
      log.warn('Could not parse claude JSON output — using raw text, token stats unavailable');
      return {
        body:         rawOutput,
        inputTokens:  0,
        outputTokens: 0,
        costUsd:      0,
        durationMs:   0,
      };
    }

    // ---- Extract token usage ----
    //
    // BGG's API tokens break into three categories we sum for "input":
    //   input_tokens                : the literal prompt tokens we sent
    //   cache_creation_input_tokens : tokens used to CREATE a new cache entry (billed normally)
    //   cache_read_input_tokens     : tokens served FROM cache (cheaper but still "used")
    //
    // We sum all three so the footer shows total context consumed.
    // Python: sum(v for k, v in usage.items() if k != 'output_tokens')
    const u = parsed.usage ?? {};  // `?? {}` = empty object if usage is missing
    const inputTokens =
      (u.input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0);

    return {
      body:         parsed.result ?? rawOutput,  // Fall back to raw if 'result' key missing
      inputTokens,
      outputTokens: u.output_tokens ?? 0,
      costUsd:      parsed.total_cost_usd ?? 0,
      durationMs:   parsed.duration_ms ?? 0,
    };

  } finally {
    // Always delete the temp file, even if an error was thrown above.
    // fs.unlink() is async with a no-op callback — fire and forget.
    // Python: os.unlink(tmp_file)  (in finally block, synchronous)
    fs.unlink(tmpFile, () => undefined);
  }
}
