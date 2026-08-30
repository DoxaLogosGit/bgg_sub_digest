// ============================================================
// email.ts — send the finished digest via Resend
//
// Converts the markdown digest to HTML (so Gmail renders it
// properly) and sends it using the Resend API.
//
// Called from index.ts after the digest file is written.
// If email config is absent, this is a no-op so the feature
// is entirely optional.
// ============================================================

import { Resend } from 'resend';
import { marked } from 'marked';
import { log } from './logger';

export interface EmailConfig {
  resendApiKey: string;
  from: string;
  to: string;
}

// sendDigestEmail — convert markdown to HTML and send via Resend.
//
// subject: the email subject line (e.g. "BGG Digest — Monday, April 28, 2026")
// markdownBody: the full digest markdown string
//
// Returns true on success, false on failure (errors are logged, not thrown,
// so a mail failure never kills the digest run).
export async function sendDigestEmail(
  emailConfig: EmailConfig,
  subject: string,
  markdownBody: string,
): Promise<boolean> {
  try {
    // marked() converts markdown to an HTML string.
    // It handles headers, bold, lists, links, horizontal rules — everything in the digest.
    // `await` is needed because marked returns a Promise in async mode.
    const htmlBody = await marked(markdownBody);

    // Wrap in minimal HTML so email clients render fonts/spacing correctly.
    // The <meta charset> ensures emoji and special characters render properly.
    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: sans-serif; max-width: 800px; margin: 0 auto; padding: 16px;">
${htmlBody}
</body>
</html>`;

    const resend = new Resend(emailConfig.resendApiKey);

    const { error } = await resend.emails.send({
      from: emailConfig.from,
      to:   emailConfig.to,
      subject,
      html,
    });

    if (error) {
      log.error('Resend API error', { error: String(error) });
      return false;
    }

    log.info(`Digest emailed to ${emailConfig.to}`);
    return true;

  } catch (err) {
    log.error('Failed to send digest email', { err: String(err) });
    return false;
  }
}

// buildEmailSubject — formats a subject line from the digest date.
// "BGG Digest — Monday, April 28, 2026"
export function buildEmailSubject(date: Date): string {
  return `BGG Digest — ${date.toLocaleDateString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  })}`;
}

// ============================================================
// statusSubjectPrefix — status tag for the email subject
// ============================================================
//
// EVERY subject carries a status tag, successes included. Before 2026-08-30
// only failures were tagged, which produced this: the 3am cron run failed
// (ollama 402) and sent "[GENERATION FAILED] BGG Digest — Sunday, August 30,
// 2026", then three later runs succeeded and sent the bare "BGG Digest —
// Sunday, August 30, 2026". buildEmailSubject() encodes only the DATE, so
// every run on a given day produces the same base subject, Gmail collapses
// them into one conversation, and the conversation shows the FIRST message's
// subject — leaving a good digest sitting under a GENERATION FAILED heading
// for the rest of the day.
//
// Tagging success explicitly gives failures and successes DIFFERENT subject
// lines, so a failed run can no longer head a thread of good ones.
//
// KNOWN LIMIT: this does not stop threading outright. Several successful runs
// in one day still share "[OK] BGG Digest — <date>" and will still group
// together — which is harmless, since they are all successes. If you want
// every run to stand alone, the subject needs a time component too.
export function statusSubjectPrefix(
  status: 'complete' | 'partial' | 'rate_limited' | 'invalid' | 'error',
  skippedCount = 0,
): string {
  // Order matters: 'partial' is also implied by a non-empty skipped list, so
  // the hard-failure states must be checked first.
  if (status === 'invalid' || status === 'error') return '[GENERATION FAILED] ';
  if (status === 'rate_limited')                  return '[RATE LIMITED] ';
  if (status === 'partial' || skippedCount > 0)   return '[PARTIAL] ';
  return '[OK] ';
}
