# Highlights block format

The Highlights block is the cross-subscription summary at the top of the
digest. **Important:** write this block LAST in your output (after every
subscription section). Automated post-processing lifts it to the top.

The header line MUST be **exactly** this string, on its own line:

```
## ⭐ Highlights
```

The post-processor matches that header to find and lift the block. Variants
like `## Highlights` (no star) or `### Highlights` (wrong level) will be
missed. Pin the header text.

## Format

```markdown
## ⭐ Highlights

- ⭐ <Tracked game> — <one-line summary of where it appeared and why it matters>
- ⭐ <Another tracked game> — <...>
- ⭐ <Major theme: solo / cooperative / crowdfunding / review / etc> — <one-line cross-section summary>
- ⭐ <...>
```

## Content rules

- One bullet per **cross-subscription** standout — items matching the
  reader's tracked games or priority interests from INTERESTS.md.
- One bullet per **major theme** that appeared multiple times across
  sections (solo, cooperative, crowdfunding/kickstarter, review, etc.).
- Each bullet is **concise** — the section below has the full content.
  This block is the index, not the body.
- Do NOT duplicate full subscription content here. If a tracked game
  appears in three subscriptions, write ONE bullet that mentions all
  three, not three bullets.
- Begin with `## ⭐ Highlights` exactly, no preamble.
