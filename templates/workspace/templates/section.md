# Per-subscription section format

Use exactly this structure for each subscription. Replace placeholder
text in `<...>` with content from the subscription's data file.

```markdown
### [<Subscription Title>](<URL>)
*Parent: <parentName>* — only include this line if `parentName` is set in the manifest entry

**Summary:** 2–4 sentences on what's new and the overall tone.

**New Activity:**
- Bullet per notable item (max 8). Include author, brief description, and link where available. Mark items matching the reader's interests with ⭐.

**Topics Mentioned:** comma-separated list of matched interests, or "none"
```

## Notes

- The first character of each section is `#` — start with the `### [` header line, no preamble.
- Bullets should be substantive — author, what they said, and (for threads) a quoted snippet or paraphrase. Skip the "*Parent:*" line entirely if the manifest entry has no `parentName`.
- For high-volume subs (itemCount > 30), the Summary is a thematic overview rather than a per-post recap, but ⭐ bullets for tracked games / priority interests still appear in the New Activity list.
- "Topics Mentioned" is comma-separated, lowercase if natural, drawn from INTERESTS.md keywords and tracked-game names that actually appear in this subscription's content.
