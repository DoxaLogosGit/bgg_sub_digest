# Reading BGG data files

This guide covers how to read the subscription data files correctly. The
formats have traps that have produced wrong digests before. Read this before
you summarise anything.

## 1. Attribution — who actually said it

**This is the most common error. Read this section twice.**

Every thread post looks like this:

```
[Post by Dormammu on 8/30/2026]
Subject: Re: Any Future Content Predictions?
Link: https://boardgamegeek.com/thread/3759579?article=48117398
> **stephenfurmanek wrote:**
> Cloak and Dagger would be an interesting experiment as a "double identity hero".

This is less true in practice than you might think.
```

- **The author is the name in `[Post by ... ]`.** Here that is **Dormammu**.
- **Lines beginning with `>` are a QUOTE of an EARLIER post.** `> **X wrote:**`
  means X is being quoted — X is **not** the person speaking in this post.
- **The post's own words are the lines that do NOT start with `>`.** Here:
  "This is less true in practice than you might think."

So the correct bullet is *"Dormammu pushed back on the Cloak and Dagger idea"* —
**never** *"stephenfurmanek suggested Cloak and Dagger"*, even though
stephenfurmanek's name appears inside the post.

**Quotes nest.** You will see several `>` levels stacked, each naming a
different person:

```
> **Dormammu wrote:**
> stephenfurmanek wrote:
```

All of it is quoted history. The author is still only the name in `[Post by ...]`.

**Geeklists have the same trap** in a different shape. A comment echoes the
item's text before adding its own:

```
  ↳ Comment by iceman23 on 8/29/2026: My wife will appreciate the space more than anything!

This is why I can't enter these things! Not in!
```

The first line is the **item author's** text being quoted back. iceman23's
actual contribution is *"This is why I can't enter these things! Not in!"* —
summarise that, not the echoed line.

**Rule:** before writing any bullet, find the nearest `[Post by ...]` or
`↳ Comment by ...` marker above the text. That name is the author. Every
other name in the block is being quoted or discussed.

## 2. Coverage — one bullet per post

Each post has a unique `article=NNNN` id; each geeklist item has a unique
`#itemNNNN` id. **Write one bullet per distinct id.** Do not merge two posts
into a single bullet, and do not skip a post because it seems similar to the
one before it. If two people made the same point, that is two bullets.

The digest exists so the reader does not have to open BGG. A dropped post is
activity they never learn about.

(The `max 8` bullet cap in `templates/section.md` still applies to very large
subscriptions — when you must choose, keep the posts that match INTERESTS.md.)

## 3. Stub files — do not infer content

A file that says:

```
New activity on a BGG thread you subscribe to (new replies beyond API window).
```

means the replies were **not retrievable**. You have the title and nothing
else. Say so plainly — *"new replies, content not retrievable"* — and do not
invent or infer what the discussion contained. The title is a subject line,
not evidence of what was said.

## 4. Highlights must name things

A highlight bullet must lead with a **specific game or a concrete topic**.
Bare category words are not highlights:

- Bad: `⭐ Review — several reviews appeared`
- Bad: `⭐ Expansion — expansions were discussed`
- Bad: `⭐ Giveaway — a giveaway happened`
- Good: `⭐ Earthborne Rangers — a rules question about Spirit Beings, plus video reviews of Spire in Bloom`
- Good: `⭐ Solo play — dominated the SGOYT geeklist, with 50 session reports including Duel of Meloch and The Old King's Crown`

A theme bullet is fine, but it must carry specifics (which games, which
subscriptions) rather than restating the category name.

## 5. BGG conventions worth knowing

- `Re:` on a subject line is just a reply marker — not part of the topic.
- Trade and sale threads use `H:` (have), `W:` (want), plus WTB / WTS / WTT.
  Summarise these in one line; they are rarely interesting.
- Common abbreviations: **SGOYT** (Solitaire Games on Your Table),
  **PIFF** (Pay It Forward Fun, a gifting/giveaway geeklist), **P500**
  (GMT's preorder system), **KS** (Kickstarter), **PnP** (print and play),
  **OOP** (out of print), **FLGS** (friendly local game store),
  **AP** (analysis paralysis), **BGG** (the site itself).
- A geeklist item's `[Item by X posted DATE, last activity DATE]` header means
  X created the item; the comments beneath it are from other people.
- "Geekgold", "thumbs", and microbadges are site currency/reactions. They
  rarely matter to a digest — do not build a bullet around them.

## 6. Never narrate

Write digest content only. Do not write sentences about what you are about to
do, what you just did, or how you are organising the work. No "Now, next
section:", no "Let's craft the Highlights block", no "We'll output it all at
once." Your entire response is the digest — begin with the first `### [` header
and emit nothing but digest markdown until the final Highlights bullet.
