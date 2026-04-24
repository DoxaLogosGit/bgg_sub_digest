// ============================================================
// digest.ts — write the final markdown digest file
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

// Wrap Claude's digest body with a dated header.
export function buildMarkdown(generatedAt: Date, claudeBody: string): string {
  return [
    '# BGG Subscription Digest',
    `*Generated: ${formatDate(generatedAt)}*`,
    '',
    claudeBody,
  ].join('\n');
}

// Write to a date-stamped file in outputDir. Returns the full path.
export function writeDigest(markdown: string, outputDir: string, generatedAt: Date): string {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const dateStr = generatedAt.toISOString().slice(0, 10);
  const fullPath = path.join(outputDir, `bgg-digest-${dateStr}.md`);

  fs.writeFileSync(fullPath, markdown, 'utf-8');
  log.info('Digest written', { path: fullPath, bytes: markdown.length });

  return fullPath;
}
