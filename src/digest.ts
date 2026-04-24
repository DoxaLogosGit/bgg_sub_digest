// ============================================================
// digest.ts — write the final markdown digest file
//
// This module is intentionally simple — it just wraps Claude's
// markdown output with a dated header and writes it to disk.
//
// PYTHON CONTEXT: All three functions here are pure utilities
// with no async work. In Python these would be plain functions
// in a utils.py or output.py module.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';

// ---- formatDate -----------------------------------------------
//
// Converts a Date to a human-readable string for the digest header.
// Example: "Thursday, April 24, 2025"
//
// .toLocaleDateString() uses the ICU locale data built into Node.js.
// Python: d.strftime('%A, %B %-d, %Y')  (%-d = day without zero-padding)
function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    weekday: 'long',   // "Thursday"
    year:    'numeric', // "2025"
    month:   'long',   // "April"
    day:     'numeric', // "24" (no leading zero)
  });
}

// ---- buildMarkdown --------------------------------------------
//
// Prepends a title header and generation timestamp to Claude's output.
// Returns the complete markdown string ready to write to disk.
//
// PYTHON CONTEXT: `export function` makes this available to index.ts.
// Parameters with types: `generatedAt: Date` = positional arg with type annotation.
// Python: def build_markdown(generated_at: datetime, claude_body: str) -> str:
//
// Array.join('\n') is Python's '\n'.join([...])
export function buildMarkdown(generatedAt: Date, claudeBody: string): string {
  return [
    '# BGG Subscription Digest',
    `*Generated: ${formatDate(generatedAt)}*`,
    '',             // Blank line between header and body
    claudeBody,
  ].join('\n');
}

// ---- writeDigest ----------------------------------------------
//
// Writes the markdown string to a date-stamped file in the output
// directory. Creates the directory if it doesn't exist.
// Returns the full absolute path to the file that was written.
//
// Example output path: ./digests/bgg-digest-2025-04-24.md
export function writeDigest(markdown: string, outputDir: string, generatedAt: Date): string {
  // Create the output directory if it doesn't already exist.
  // { recursive: true } = like mkdir -p — no error if it already exists.
  // Python: os.makedirs(output_dir, exist_ok=True)
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Extract just the date portion from the ISO timestamp: "2025-04-24T..."
  // .slice(0, 10) gives us "2025-04-24"
  // Python: generated_at.strftime('%Y-%m-%d')
  const dateStr = generatedAt.toISOString().slice(0, 10);

  // path.join() builds a cross-platform file path.
  // Python: os.path.join(output_dir, f'bgg-digest-{date_str}.md')
  const fullPath = path.join(outputDir, `bgg-digest-${dateStr}.md`);

  // Write the entire markdown string to the file synchronously.
  // If the file already exists, it is overwritten (no append).
  // Python: Path(full_path).write_text(markdown, encoding='utf-8')
  fs.writeFileSync(fullPath, markdown, 'utf-8');

  log.info('Digest written', { path: fullPath, bytes: markdown.length });
  return fullPath;
}
