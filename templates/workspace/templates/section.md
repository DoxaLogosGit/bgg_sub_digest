# Per-subscription section format

Use exactly this structure for each subscription. Replace placeholder
text in `<...>` with content from the subscription's data file.

```markdown
### [<Subscription Title>](<URL>)
*Parent: <parentName>*
**💬 Replies to you:** <reasons, joined with "; ">

**Summary:** 2–4 sentences on what's new and the overall tone.

**New Activity:**
- Bullet per notable item (max 8). Include author, brief description, and link where available. Mark items matching the reader's interests with ⭐.

**Topics Mentioned:** comma-separated list of matched interests, or "none"
```

## Notes

- The first character of each section is `#` — start with the `### [` header line, no preamble.
- The `*Parent:*` line is OPTIONAL: include it ONLY when the manifest entry has a
  `parentName`, and then write nothing after the closing `*` — no dash, no note.
  Omit the whole line when there is no `parentName`; never emit an empty
  `*Parent: *`. (This instruction used to sit on the pattern line above, and
  models copied its trailing em dash into every rendered section.)
- The `**💬 Replies to you:**` line is OPTIONAL and appears ONLY when the
  manifest entry has a `selfActivity` field. Join its `reasons` array with
  "; " and write nothing else on the line. Omit the whole line otherwise —
  never emit it empty, and never invent one for a subscription whose manifest
  entry has no `selfActivity`. Keep it a plain line, NOT a bullet.
- When the line is present, lead the **Summary** with what those people
  actually said to the reader, before covering the rest of the subscription.
  That is the part he needs and the reason the section is at the top.
- Bullets should be substantive — author, what they said, and (for threads) a quoted snippet or paraphrase. Skip the "*Parent:*" line entirely if the manifest entry has no `parentName`.
- For high-volume subs (itemCount > 30), the Summary is a thematic overview rather than a per-post recap, but ⭐ bullets for tracked games / priority interests still appear in the New Activity list.
- "Topics Mentioned" is comma-separated, lowercase if natural, drawn from INTERESTS.md keywords and tracked-game names that actually appear in this subscription's content.
