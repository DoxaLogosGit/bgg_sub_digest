// ============================================================
// types.ts — shared TypeScript type definitions
//
// PYTHON CONTEXT: TypeScript has a structural type system that is
// erased at compile time — interfaces and types exist only so the
// compiler can catch mistakes. At runtime they disappear entirely.
// Think of them like Python's typing module: helpful for IDEs and
// linters, but no runtime overhead.
//
// Two main constructs here:
//
//   `type`      — an alias for a union of string literals.
//                 Python equivalent: Literal['thread', 'geeklist', 'unknown']
//                 from typing import Literal
//
//   `interface` — a named shape for an object (like a dataclass or
//                 TypedDict in Python, but only enforced by the compiler).
//
// The `export` keyword makes a definition visible to other files that
// import it. Without `export` it stays private to this module — same
// idea as putting something in a module but not in __all__.
// ============================================================

// ---- Subscription type -----------------------------------------
//
// A "union type" of three string literals. TypeScript knows that
// a SubscriptionType value can ONLY be one of these three strings.
// Python equivalent:
//   SubscriptionType = Literal['thread', 'geeklist', 'unknown']
//
// The | character is "or" for types (not bitwise OR).
export type SubscriptionType = 'thread' | 'geeklist' | 'unknown';

// ---- Interfaces ------------------------------------------------
//
// `interface` declares the shape (property names + types) of an object.
// It's closest to Python's TypedDict or a frozen @dataclass — there's
// no constructor logic, just a description of the fields.
//
// TypeScript checks that every object you assign to this interface
// has exactly these fields with the right types. No extra runtime cost.

export interface BggSubscription {
  // 'thread' | 'geeklist' | 'unknown'  (the SubscriptionType alias above)
  type: SubscriptionType;

  // The numeric BGG ID extracted from the URL — e.g. /thread/3456789 → 3456789
  // TypeScript's `number` is always a float64 (like Python's float), but we
  // use parseInt() throughout so it behaves like an integer.
  id: number;

  // The text label shown in the BGG notification row (e.g. "SGOYT April 2024")
  title: string;

  // The canonical URL to this subscription's content (thread or geeklist page)
  url: string;

  // Specific item or article IDs that BGG flagged as outstanding in this run.
  // Extracted from the GG-ITEM-LINK-UI notification row URLs.
  //
  // `number[]` is TypeScript's syntax for "array of number" — same as
  // Python's list[int]. You may also see Array<number> which is identical.
  //
  // If BGG's URL doesn't encode a specific item, this is an empty array [],
  // and we fall back to fetching the most-recent N items from the API.
  notifiedItemIds: number[];
}

// ---- Thread types ----------------------------------------------
//
// A single post (reply) inside a BGG forum thread.
// BGG calls them "articles" in both the UI and the XML API.
export interface BggThreadArticle {
  id: number;
  username: string;

  // TypeScript's Date is equivalent to Python's datetime.datetime.
  // We always parse BGG's date strings into Date objects so the rest
  // of the code can compare/sort them without string parsing.
  postdate: Date;
  editdate: Date;

  // The post subject line (often blank for replies in a thread)
  subject: string;

  // The post body, already stripped of HTML/BBCode and truncated to 1000 chars
  body: string;

  // Direct link to this specific article within the thread
  // e.g. https://boardgamegeek.com/thread/3456789&article=47582634
  link: string;
}

// A complete BGG thread with all its articles
export interface BggThread {
  id: number;
  subject: string;   // The thread title
  link: string;      // Canonical URL
  articles: BggThreadArticle[];
  numArticles: number;  // Total article count as reported by the API
}

// ---- Geeklist types --------------------------------------------
//
// A BGG geeklist is a community-curated list of board games.
// Each "item" is one game entry added by a member.

export interface BggGeeklistComment {
  username: string;
  date: Date;
  body: string;  // Already stripped of markup and truncated to 300 chars
}

export interface BggGeeklistItem {
  id: number;
  username: string;    // Who added this game to the geeklist
  postdate: Date;
  editdate: Date;
  objectName: string;  // The game name (e.g. "Spirit Island")
  objectId: number;    // BGG's internal game ID
  body: string;        // The member's description, stripped + truncated
  link: string;        // Direct URL to this item within the geeklist
  comments: BggGeeklistComment[];
}

// A complete BGG geeklist
export interface BggGeeklist {
  id: number;
  title: string;
  username: string;    // Who created the geeklist
  editdate: Date;
  description: string; // The geeklist description, stripped + truncated
  items: BggGeeklistItem[];
}
