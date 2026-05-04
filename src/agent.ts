// ============================================================
// agent.ts — write subscription data files and invoke an agent (claude or tallow) to produce the digest
//
// ARCHITECTURE (file-based, replaces the old single-prompt approach):
//
//   1. For each outstanding BGG subscription, format its content and
//      write it to ./digest-data/[type]-[id].md
//
//   2. Write a manifest.json listing all subscription files with metadata.
//
//   3. Launch the configured agent with a prompt telling it to read the
//      manifest then each subscription file via its Read tool:
//        - Claude:  `claude --model <m> --dangerously-skip-permissions --print --output-format json`
//        - Tallow:  `tallow --model <m> --yolo --mode json --print "<prompt>"`
//
//   4. Parse the agent's response to extract the digest body AND token usage stats.
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
// `spawn` streams stdout/stderr — used for tallow whose JSONL output can
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
    // When we have a notificationDate, drop comments older than the cutoff
    // entirely — they were already read on a prior visit and just bloat the
    // file. Without a date, fall back to "10 newest" as a sensible cap.
    // Python: [c for c in item.comments if not notif_date or c.date > notif_date]
    const filteredComments = notificationDate !== null
      ? item.comments.filter((c) => c.date > notificationDate)
      : item.comments;

    const sortedComments = [...filteredComments]
      .sort((a, b) => b.date.getTime() - a.date.getTime())
      .slice(0, 10);

    for (const c of sortedComments) {
      const cd = c.date.toLocaleDateString('en-US');
      lines.push(`  ↳ Comment by ${c.username} on ${cd}: ${c.body}`);
    }

    // Note if we capped (or filtered out) any comments
    const omitted = filteredComments.length > 10 ? filteredComments.length - 10 : 0;
    if (omitted > 0) {
      lines.push(`  ↳ (${omitted} older comments not shown)`);
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

  // 'thread' for forum threads, 'geeklist' for community curated lists,
  // plus the secondary types for game-page / blog / file-page subscriptions
  // that we follow for new content (no XML API but we scrape the HTML).
  type: 'thread' | 'geeklist' | 'boardgame' | 'boardgameexpansion' | 'blog' | 'filepage' | 'unknown';

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

  // The parent boardgame/expansion name when this thread or geeklist lives
  // inside a game's forum (e.g. "Nusfjord: Big Box"). Lets the digest group
  // and label related discussion. Captured from a sibling /boardgame URL in
  // the same notice row.
  parentName?: string;
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
// 'complete'     — every subscription rendered, Highlights produced
// 'partial'      — some subscriptions skipped after retries (model/timeout errors)
// 'rate_limited' — halted mid-digest after a 429; Highlights skipped
export type DigestStatus = 'complete' | 'partial' | 'rate_limited';

export interface DigestSkippedEntry {
  title:    string;
  filePath: string;
  reason:   string;
}

export interface DigestResult {
  body: string;          // Claude's full markdown digest text
  inputTokens: number;   // Total context tokens (prompt + cache hits + cache creation)
  outputTokens: number;  // Tokens in Claude's response
  costUsd: number;       // Estimated cost in USD (from total_cost_usd in JSON output)
  durationMs: number;    // Wall-clock time for the full Claude call
  // Per-subscription orchestration metadata. Optional — undefined for the
  // plain-claude single-call path; populated by the Ollama per-subscription
  // orchestrator. The caller uses these to flag the digest as PARTIAL or
  // RATE_LIMITED in the email subject and the body banner.
  status?:         DigestStatus;
  completedCount?: number;             // sections successfully rendered
  totalCount?:     number;             // total subscriptions in manifest
  skipped?:        DigestSkippedEntry[];
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
function buildDigestPrompt(
  manifestPath: string,
  interests: string,
): string {
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
  - "type": "thread", "geeklist", "blog", "filepage", "boardgame", or "boardgameexpansion"
  - "filePath": absolute path to the subscription's data file — read this with your Read tool
  - "itemCount": how many items are in the data file
  - "unreadCount": number of new-activity rows BGG showed for this subscription (1 per new article/item)
  - "notificationDate": when this subscription was last visited (ISO timestamp or null)
  - "parentName" (optional): when present, this thread/geeklist/page lives inside a specific game's
    forum (e.g. "Nusfjord: Big Box", "Marvel Champions: The Card Game"). Use it to label and group.

For EACH subscription in the manifest:
1. Read the subscription's data file (use the "filePath" value from the manifest)
2. Write a section in this markdown format:

### [Subscription Title](URL)
*Parent: <parentName>* — only include this line if parentName is set in the manifest entry

**Summary:** 2–4 sentences on what's new and the overall tone.

**New Activity:**
- Bullet per notable item (max 8). Include author, brief description, and link where available. Mark items matching my interests with ⭐.

**Topics Mentioned:** comma-separated list of matched interests, or "none"

---

CRITICAL WORKFLOW — follow exactly:
1. Read the manifest.json file first
2. Read EVERY file listed in the manifest's "filePath" fields — all of them, in order
3. Do NOT write any content while reading files — no progress narration, no partial sections
4. ONLY AFTER reading ALL files: write the complete digest in a SINGLE response
5. That single response MUST begin with "## ⭐ Highlights"
6. The entire digest — every section — must be in that ONE final response
7. Do NOT say "the digest is above" or reference earlier turns

Output rules:
- Begin your output with "## ⭐ Highlights" — no preamble, no duplicate title (the digest already has a wrapper header)
- After Highlights, render each subscription section in the format above
- Order sections this way:
  1. Subscriptions matching my "Priority Subscriptions" interests FIRST
  2. Subscriptions whose parentName matches one of my "Games I'm Tracking"
  3. Other subscriptions whose parentName is set (game-related discussion not on my priority list)
  4. Everything else last
- The Highlights section lists ⭐ items across ALL subscriptions before the individual sections
- For high-volume subscriptions (itemCount > 30), summarize overall activity by THEME — but still list individual ⭐ bullets for any items that match my tracked games or priority interests, even if there are dozens of them. Priority items always get the full bullet treatment; the rest of the volume gets the thematic summary.
- INCLUDE every subscription in the manifest at least briefly — even pure trade/sale or off-topic threads. For low-relevance ones, a one-line summary with the link is fine. Do not silently omit a subscription.
- When grouping multiple subscriptions with the same parentName, put them adjacent so the user can see all activity for one game together.
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
export function runClaudeDigest(
  manifestPath: string,
  interests: string,
  model = 'opus',
): DigestResult {
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
    // Cron runs with a minimal PATH that typically doesn't include ~/.local/bin
    // or wherever `claude` was installed. We extend the inherited PATH with the
    // common locations so spawnSync can find the binary regardless of how this
    // process was launched (interactive shell vs. cron vs. systemd timer).
    const home = process.env.HOME ?? '';
    const extraPaths = [
      `${home}/.local/bin`,           // npm global on Linux (most common for claude)
      `${home}/.npm-global/bin`,      // npm with custom prefix
      `${home}/.nvm/versions/node/current/bin`, // nvm current
      '/usr/local/bin',               // homebrew / manual installs
    ].filter(Boolean);
    const augmentedPath = [...extraPaths, process.env.PATH ?? ''].join(':');

    const cmd = `claude --model ${model} --dangerously-skip-permissions --print --output-format json < "${tmpFile}"`;

    const result = spawnSync(cmd, {
      shell:     true,
      encoding:  'utf-8',
      // 45-minute hard cap. Anthropic-backed runs typically finish in 1–2 min,
      // but Ollama-backed runs (claude-ollama) routinely take 5–15 min and
      // have high variance day-to-day; cron hits the slow tail. Matches/exceeds
      // tallow's 30-min ceiling.
      timeout:   45 * 60 * 1000,
      maxBuffer: 20 * 1024 * 1024,  // 20 MB max output buffer
      env:       { ...process.env, PATH: augmentedPath },
    });

    // `result.error` is set if spawnSync itself failed (e.g. command not found).
    // This is different from a non-zero exit code — it's a Node.js-level spawn error.
    // Python: subprocess.SubprocessError vs. result.returncode != 0
    if (result.error) throw result.error;

    // .trim() strips leading/trailing whitespace — Python: result.stdout.strip()
    const rawOutput = result.stdout?.trim() ?? '';

    if (result.status !== 0) {
      // Non-zero exit = claude CLI reported an error.
      // With --output-format json, claude writes a structured error object to
      // STDOUT (not stderr) — e.g. when Ollama returns 404 for an unknown
      // model, the body contains {is_error:true, api_error_status:404,
      // result:"There's an issue with the selected model..."}. Surface that
      // text instead of an empty stderr message.
      let detail = '';
      if (rawOutput) {
        try {
          const parsed = JSON.parse(rawOutput) as {
            result?: string;
            is_error?: boolean;
            api_error_status?: number;
          };
          if (parsed.is_error && parsed.result) {
            detail = parsed.api_error_status
              ? `[HTTP ${parsed.api_error_status}] ${parsed.result}`
              : parsed.result;
          }
        } catch {
          // Not JSON — fall through and use raw stdout as the diagnostic.
          detail = rawOutput.slice(0, 500);
        }
      }
      if (!detail) detail = result.stderr?.slice(0, 500) ?? '';
      throw new Error(
        `claude CLI exited with code ${result.status}: ${detail || '(no output)'}`,
      );
    }

    if (!rawOutput) throw new Error('claude CLI returned empty output');

    // Save the raw JSON output to logs/ so we can post-mortem when the body
    // comes back empty or malformed (e.g. the model looped on tool_use blocks
    // without synthesizing a final text turn). The file path is logged so
    // you can grep for it.
    try {
      const logsDir = path.join(process.cwd(), 'logs');
      if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
      const stamp   = new Date().toISOString().replace(/[:.]/g, '-');
      const rawPath = path.join(logsDir, `claude-raw-${stamp}.json`);
      fs.writeFileSync(rawPath, rawOutput, 'utf-8');
      log.debug('Claude raw JSON saved', { rawPath, bytes: rawOutput.length });
    } catch (writeErr) {
      log.warn('Could not save raw claude JSON', { err: String(writeErr) });
    }

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

// ============================================================
// Per-subscription single-shot path (claude-ollama + tallow)
// ============================================================
//
// Why this exists: the original "one giant call, model uses Read tools to
// pull each subscription file" pattern degrades on Ollama-served models with
// 200K context windows. Two failure modes observed:
//   - nemotron-3-super: claude's automatic context compaction works but the
//     model degenerates (repetition collapse, multiple Highlights sections)
//   - mistral-large-3:675b: hits the 200K ceiling and silently drops
//     subscriptions, over-summarizing the rest
//
// Per-subscription single-shot calls keep each prompt small (one file's
// content + interests, ~2-10K tokens), so neither failure mode triggers.
// 41 subscriptions => 41 sequential model calls + 1 final highlights call.
//
// Runs serial because Ollama's free tier serializes a single model anyway.
// The plain-claude path against Anthropic still uses the original tool-loop
// approach (runClaudeDigest), which works fine there.

// ---- isRateLimitError ----------------------------------------
//
// Detect 429 / quota errors from either claude (api_error_status:429 in
// JSON, or "[HTTP 429] ..." in our error wrapper) or tallow (errorMessage
// like '429 "you (DoxaLogos) have reached your weekly usage limit..."').
// On a hit the orchestrator halts immediately — no retry, no further work.
function isRateLimitError(text: string): boolean {
  if (!text) return false;
  return /\b429\b/.test(text);
}

// ---- SingleCallResult ----------------------------------------
//
// Return shape of one single-shot agent call. errorKind is set only on
// failure: 'rate_limit' for 429s (halt the whole orchestrator),
// 'other' for everything else (timeout, model error, parse error → retry).
interface SingleCallResult {
  body:          string;
  inputTokens:   number;
  outputTokens:  number;
  costUsd:       number;
  errorKind?:    'rate_limit' | 'other';
  errorMessage?: string;
}

// Per-call wall-clock cap. Single-shot prompts contain one subscription
// file inline (largest seen ~44KB / 7K words), so each call is bounded —
// but cloud-routed Ollama models can be slow on big inputs and have
// occasional latency spikes. 240s gives generous headroom; total worst
// case at 41 subs × 240s = ~2.7h, but typical per-call is 5-30s and
// most digests should land in 15-30 min.
const PER_CALL_TIMEOUT_MS = 240_000;

// ---- runClaudeSingleCall -------------------------------------
//
// One claude invocation with a fully-inlined prompt (no tool loop, no Read
// calls — content is in the prompt body). Routed via direct env vars
// (ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL), NOT
// `ollama launch claude` — the launch wrapper has heavy per-invocation
// startup overhead (~60s+) which is fine for a single big tool-loop call
// but fatal when we're making 41+ small calls in a row. Direct env-var
// routing was empirically validated earlier in this codebase's history
// against qwen35-pi at ~56s per call (vs 12 min through the wrapper).
function runClaudeSingleCall(prompt: string, model: string): SingleCallResult {
  const tmpFile = path.join(
    os.tmpdir(),
    `bgg-call-${Date.now()}-${Math.random().toString(36).slice(2, 9)}.txt`,
  );
  const home       = process.env.HOME ?? '';
  const extraPaths = [
    `${home}/.local/bin`,
    `${home}/.npm-global/bin`,
    `${home}/.nvm/versions/node/current/bin`,
    '/usr/local/bin',
  ];
  const augmentedPath = [...extraPaths, process.env.PATH ?? ''].join(':');

  try {
    fs.writeFileSync(tmpFile, prompt, 'utf-8');

    const cmd = `claude --model ${model} --dangerously-skip-permissions --print --output-format json < "${tmpFile}"`;

    const result = spawnSync(cmd, {
      shell:     true,
      encoding:  'utf-8',
      timeout:   PER_CALL_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: augmentedPath,
        // Point claude at the local Ollama OpenAI-compatible endpoint.
        // See: https://docs.ollama.com/integrations/claude-code
        ANTHROPIC_AUTH_TOKEN: 'ollama',
        ANTHROPIC_API_KEY:    '',
        ANTHROPIC_BASE_URL:   'http://localhost:11434',
      },
    });

    if (result.error) {
      const msg = String(result.error);
      return {
        body: '', inputTokens: 0, outputTokens: 0, costUsd: 0,
        errorKind:    isRateLimitError(msg) ? 'rate_limit' : 'other',
        errorMessage: msg.slice(0, 500),
      };
    }

    const rawOutput = result.stdout?.trim() ?? '';

    // Parse JSON — claude returns JSON even on api errors (is_error:true).
    let parsed: {
      result?:           string;
      is_error?:         boolean;
      api_error_status?: number;
      total_cost_usd?:   number;
      usage?: {
        input_tokens?:                number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?:     number;
        output_tokens?:               number;
      };
    };
    try {
      parsed = JSON.parse(rawOutput);
    } catch {
      const detail = rawOutput || result.stderr?.slice(0, 500) || '(no output)';
      return {
        body: '', inputTokens: 0, outputTokens: 0, costUsd: 0,
        errorKind:    isRateLimitError(detail) ? 'rate_limit' : 'other',
        errorMessage: detail.slice(0, 500),
      };
    }

    const u            = parsed.usage ?? {};
    const inputTokens  = (u.input_tokens ?? 0)
                       + (u.cache_creation_input_tokens ?? 0)
                       + (u.cache_read_input_tokens ?? 0);
    const outputTokens = u.output_tokens ?? 0;
    const costUsd      = parsed.total_cost_usd ?? 0;

    if (parsed.is_error) {
      const detail = `[HTTP ${parsed.api_error_status ?? '?'}] ${parsed.result ?? ''}`;
      const kind   = (parsed.api_error_status === 429 || isRateLimitError(detail))
        ? 'rate_limit' as const
        : 'other' as const;
      return {
        body: '', inputTokens, outputTokens, costUsd,
        errorKind:    kind,
        errorMessage: detail.slice(0, 500),
      };
    }

    return {
      body: parsed.result ?? '',
      inputTokens, outputTokens, costUsd,
    };
  } finally {
    fs.unlink(tmpFile, () => undefined);
  }
}

// ---- runTallowSingleCall -------------------------------------
//
// One tallow invocation with an inlined prompt. spawnSync (not stream) is
// fine here because single-shot has no tool round-trips echoing files —
// output is bounded. Parses the JSONL stream from stdout, walks events to
// find the assistant text, and detects 429 errorMessages.
function runTallowSingleCall(prompt: string, model: string): SingleCallResult {
  const home       = process.env.HOME ?? '';
  const extraPaths = [
    `${home}/.bun/bin`,
    `${home}/.local/bin`,
    `${home}/.npm-global/bin`,
    `${home}/.nvm/versions/node/current/bin`,
    '/usr/local/bin',
  ];
  const augmentedPath = [...extraPaths, process.env.PATH ?? ''].join(':');

  const args = ['--yolo', '--mode', 'json', '--model', model, '--print', prompt];

  const result = spawnSync('tallow', args, {
    encoding:  'utf-8',
    timeout:   PER_CALL_TIMEOUT_MS,
    maxBuffer: 20 * 1024 * 1024,
    env:       { ...process.env, PATH: augmentedPath },
  });

  if (result.error) {
    const msg = String(result.error);
    return {
      body: '', inputTokens: 0, outputTokens: 0, costUsd: 0,
      errorKind:    isRateLimitError(msg) ? 'rate_limit' : 'other',
      errorMessage: msg.slice(0, 500),
    };
  }

  type TallowUsage = {
    input?:       number; output?: number;
    cacheRead?:   number; cacheWrite?: number;
    cost?:        { total?: number };
  };
  type TallowContent = { type: string; text?: string };
  type TallowEvent = {
    type: string;
    message?: {
      content?:      TallowContent[];
      usage?:        TallowUsage;
      role?:         string;
      errorMessage?: string;
    };
  };

  const events: TallowEvent[] = [];
  for (const line of (result.stdout ?? '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(JSON.parse(t) as TallowEvent); } catch { /* skip */ }
  }

  // Check every event for an errorMessage. tallow emits these on assistant
  // messages when the upstream model rejects the request (e.g. 429).
  for (const ev of events) {
    const errMsg = ev.message?.errorMessage;
    if (errMsg) {
      return {
        body: '', inputTokens: 0, outputTokens: 0, costUsd: 0,
        errorKind:    isRateLimitError(errMsg) ? 'rate_limit' : 'other',
        errorMessage: errMsg.slice(0, 500),
      };
    }
  }

  // Pull the most recent non-empty text block.
  let body = '';
  let inputTokens  = 0;
  let outputTokens = 0;
  let costUsd      = 0;
  for (const ev of events) {
    if (ev.type !== 'turn_end' && ev.type !== 'message') continue;
    const u = ev.message?.usage ?? {};
    inputTokens  += (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
    outputTokens += u.output ?? 0;
    costUsd      += u.cost?.total ?? 0;
  }
  // Walk backward for the last text-bearing event.
  for (let i = events.length - 1; i >= 0; i--) {
    const content = events[i].message?.content ?? [];
    const text = content
      .filter((c) => c.type === 'text' && typeof c.text === 'string' && c.text.trim().length > 0)
      .map((c) => c.text as string)
      .join('\n');
    if (text) { body = text; break; }
  }

  if (!body) {
    return {
      body: '', inputTokens, outputTokens, costUsd,
      errorKind:    'other',
      errorMessage: `tallow produced no assistant text (${events.length} events)`,
    };
  }

  return { body, inputTokens, outputTokens, costUsd };
}

// ---- buildPerSubscriptionPrompt ------------------------------
//
// Single-subscription prompt: content inlined, no tools needed. Asks the
// model to render exactly one section in the digest's standard format.
// Returns the section markdown directly — no Highlights, no surrounding
// chrome.
function buildPerSubscriptionPrompt(
  entry: ManifestEntry,
  content: string,
  interests: string,
): string {
  const interestsBlock = interests
    ? `Reader's interests (use to highlight relevant items with ⭐):\n\n${interests}\n\n`
    : '';

  const parentLine = entry.parentName
    ? `*Parent: ${entry.parentName}*\n`
    : '';

  // For very long content, claude-ollama-served small-context models can
  // still get jammed. We don't truncate here — let the model fail per-call
  // and the orchestrator retry/skip.
  const themeNote = entry.itemCount > 30
    ? `This is a high-volume subscription (${entry.itemCount} items). Summarize overall activity by THEME in the Summary, but still call out individual ⭐ items matching the reader's tracked games or priority interests.`
    : '';

  return `${interestsBlock}You are summarizing ONE BGG (BoardGameGeek) subscription as a section of a larger digest.

Subscription metadata:
  - Title: ${entry.title}
  - URL:   ${entry.url}
  - Type:  ${entry.type}
  - Items: ${entry.itemCount}${entry.parentName ? `\n  - Parent: ${entry.parentName}` : ''}

Subscription content (between the fences):
\`\`\`
${content}
\`\`\`

Render exactly this markdown structure. Begin output with the "###" line; do not add any preamble or commentary before or after.

### [${entry.title}](${entry.url})
${parentLine}**Summary:** 2–4 sentences on what's new and the overall tone.

**New Activity:**
- Bullet per notable item (max 8). Include author, brief description, and link where available. Mark items matching the reader's interests with ⭐.

**Topics Mentioned:** comma-separated list of matched interests, or "none"

${themeNote}
Do not invent items not present in the content above. Do not write planning sentences ("Now I'll..."). Output only the section.`;
}

// ---- buildHighlightsPrompt -----------------------------------
//
// Aggregation prompt: takes already-rendered subscription sections and
// produces just the "## ⭐ Highlights" block. Run once at the end.
function buildHighlightsPrompt(renderedSections: string, interests: string): string {
  const interestsBlock = interests
    ? `Reader's interests:\n\n${interests}\n\n`
    : '';

  return `${interestsBlock}Below are subscription sections that have already been rendered for a BGG digest. Produce ONLY the cross-subscription Highlights block that will appear at the top of the digest.

Sections:

${renderedSections}

Output exactly this format. Begin with "## ⭐ Highlights"; no preamble, no rendering of subscription sections (they are already complete).

## ⭐ Highlights
- One bullet per cross-subscription standout matching the reader's tracked games or priority interests
- One bullet for each major theme (solo/cooperative/crowdfunding/review) that appeared multiple times across sections

Keep bullets concise. Do not duplicate the section content below — this block is the index, not the content.`;
}

// ---- runOllamaPerSubscriptionDigest --------------------------
//
// Orchestrator for the claude-ollama and tallow agents. Sequential
// per-subscription calls, retries non-rate-limit failures once, halts
// on rate-limit, runs a final Highlights call (skipped if rate-limited).
async function runOllamaPerSubscriptionDigest(
  agent:        'claude-ollama' | 'tallow',
  manifestPath: string,
  interests:    string,
  model:        string,
): Promise<DigestResult> {
  const start = Date.now();

  // Load the manifest and read each entry's data file.
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ManifestEntry[];

  const callOnce = (prompt: string): SingleCallResult => agent === 'tallow'
    ? runTallowSingleCall(prompt, model)
    : runClaudeSingleCall(prompt, model);

  const sections: string[]              = [];
  const skipped:  DigestSkippedEntry[]  = [];
  let totalIn   = 0;
  let totalOut  = 0;
  let totalCost = 0;
  let rateLimited = false;

  log.info(`Per-subscription orchestrator starting (${manifest.length} entries, ${agent}/${model})`);

  for (const [idx, entry] of manifest.entries()) {
    const content = fs.readFileSync(entry.filePath, 'utf-8');
    const prompt  = buildPerSubscriptionPrompt(entry, content, interests);

    let result: SingleCallResult | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      result = callOnce(prompt);
      if (!result.errorKind) break;
      if (result.errorKind === 'rate_limit') {
        rateLimited = true;
        log.warn(
          `[${idx + 1}/${manifest.length}] Rate-limit on "${entry.title}" — halting orchestrator. Detail: ${result.errorMessage}`,
        );
        break;
      }
      if (attempt === 1) {
        log.warn(
          `[${idx + 1}/${manifest.length}] Single-call failed on "${entry.title}" (attempt ${attempt}): ${result.errorMessage} — retrying`,
        );
      } else {
        log.warn(
          `[${idx + 1}/${manifest.length}] Single-call failed twice on "${entry.title}" — skipping`,
        );
      }
    }

    if (rateLimited) break;

    // Accumulate usage even on errored attempts (we paid the tokens).
    totalIn   += result!.inputTokens;
    totalOut  += result!.outputTokens;
    totalCost += result!.costUsd;

    if (result!.errorKind) {
      skipped.push({
        title:    entry.title,
        filePath: entry.filePath,
        reason:   result!.errorMessage ?? 'unknown error',
      });
      sections.push(
        `### [${entry.title}](${entry.url})\n` +
        (entry.parentName ? `*Parent: ${entry.parentName}*\n` : '') +
        `\n*⚠️ Summarization failed for this subscription (${result!.errorMessage ?? 'unknown'}) — read manually at \`${entry.filePath}\`*`,
      );
    } else {
      sections.push(result!.body.trim());
      log.debug(
        `[${idx + 1}/${manifest.length}] Rendered "${entry.title}" — ${result!.outputTokens} output tokens`,
      );
    }
  }

  const renderedSections = sections.join('\n\n');

  // ---- Highlights pass (skipped on rate-limit) ----
  //
  // Body is just the digest content — no banners here. The caller
  // (index.ts/runAgentAndWriteDigest) reads `status` and prepends the
  // appropriate banner (rate-limited / partial) so we don't double-banner.
  let body:   string;
  let status: DigestStatus;

  if (rateLimited) {
    body   = renderedSections;  // Highlights omitted; index.ts banners.
    status = 'rate_limited';
  } else {
    log.info(`All ${manifest.length} subscription(s) processed (${skipped.length} skipped) — running highlights`);
    const highlightsPrompt = buildHighlightsPrompt(renderedSections, interests);
    const h = callOnce(highlightsPrompt);

    totalIn   += h.inputTokens;
    totalOut  += h.outputTokens;
    totalCost += h.costUsd;

    if (h.errorKind === 'rate_limit') {
      // Edge case: per-subscription pass made it through, but the
      // highlights call itself hit 429. Treat as rate-limited.
      body   = renderedSections;
      status = 'rate_limited';
    } else if (h.errorKind || !h.body.trim()) {
      // Highlights failed for non-rate-limit reasons — emit sections without
      // a synthesized Highlights block. Inline note since this isn't the
      // same as PARTIAL (no subscription content was lost).
      body = (
        `*⚠️ Highlights generation failed (${h.errorMessage ?? 'empty response'}) — sections below are complete.*\n\n` +
        renderedSections
      );
      status = skipped.length > 0 ? 'partial' : 'complete';
    } else {
      body   = `${h.body.trim()}\n\n${renderedSections}`;
      status = skipped.length > 0 ? 'partial' : 'complete';
    }
  }

  return {
    body,
    inputTokens:  totalIn,
    outputTokens: totalOut,
    costUsd:      totalCost,
    durationMs:   Date.now() - start,
    status,
    completedCount: sections.length - skipped.length,
    totalCount:     manifest.length,
    skipped,
  };
}

// ============================================================
// runDigest — dispatch to claude / claude-ollama / tallow based on agent name
// ============================================================
//
// 'claude'        — claude CLI talking to Anthropic's API. Uses the original
//                   one-call tool-loop pattern; effectively unbounded
//                   context with prompt caching.
// 'claude-ollama' — claude CLI redirected at local Ollama via
//                   `ollama launch claude --model X --yes`. Uses the
//                   per-subscription single-shot orchestrator since
//                   Ollama-served models hit 200K-context failure modes.
// 'tallow'        — tallow CLI. Same per-subscription orchestrator as
//                   claude-ollama (small Ollama models, same constraints).
export type AgentName = 'claude' | 'claude-ollama' | 'tallow';

export async function runDigest(
  agent: AgentName,
  manifestPath: string,
  interests: string,
  model?: string,
): Promise<DigestResult> {
  if (agent === 'claude-ollama' || agent === 'tallow') {
    return runOllamaPerSubscriptionDigest(
      agent,
      manifestPath,
      interests,
      model ?? 'qwen3-coder-next:cloud',
    );
  }
  // Plain claude (Anthropic) — original tool-loop path, unchanged.
  return runClaudeDigest(manifestPath, interests, model);
}
