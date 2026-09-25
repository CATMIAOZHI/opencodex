/**
 * Suppresses client-side fingerprints that would otherwise be visible to
 * upstream Anthropic when a forwarding gateway sits between the client and
 * api.anthropic.com.
 *
 * TypeScript port of sub2api's `anthropicfp.NormalizeDateline` (LGPL-3.0) —
 * the algorithm is reproduced, not the code. It rewrites the
 * "Today's date is YYYY-MM-DD." sentence inside a request body back to a
 * canonical ASCII form, erasing three bits of steganographic signal (four
 * apostrophe code points and a date-separator variant) that some clients
 * embed in that sentence when they detect a non-official base URL.
 */

/** One normalized dateline occurrence, for observability. */
export interface DatelineHit {
  /** "ascii" (U+0027) | "u2019" | "u02bc" | "u02b9" as seen before normalization. */
  apostropheVariant: string;
  /** "-" | "/" as seen before normalization. */
  dateSeparator: string;
}

export interface NormalizeDatelineResult {
  /** Possibly-rewritten body. Byte-identical to input when changed=false. */
  body: string;
  hits: DatelineHit[];
  changed: boolean;
}

// Matches the fingerprinted sentence with any of the four apostrophe code
// points seen in the wild and a single separator. Two regexes (no
// backreference tricks) keep the two separators inside YYYY?MM?DD forced to
// agree, so mixed-separator strings like "Today's date is 2026-07/01." never
// match — this is what keeps user-authored prose ("Today is foo.",
// "His date is 2026-06-30.") untouched.
const DATELINE_HYPHEN = /Today(['’ʼʹ])s date is (\d{4})-(\d{2})-(\d{2})\./g;
const DATELINE_SLASH = /Today(['’ʼʹ])s date is (\d{4})\/(\d{2})\/(\d{2})\./g;

// The dateline lives in a <system-reminder> block once the conversation has
// advanced past the first turn, so the messages[].content[] scan is confined
// to what lives inside these tags.
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

function apostropheVariant(ch: string): string {
  switch (ch) {
    case "’": return "u2019";
    case "ʼ": return "u02bc";
    case "ʹ": return "u02b9";
    default: return "ascii";
  }
}

function canonicalize(year: string, month: string, day: string): string {
  return `Today's date is ${year}-${month}-${day}.`;
}

interface DatelineMatch {
  start: number;
  end: number;
  apostrophe: string;
  separator: string;
  year: string;
  month: string;
  day: string;
}

function collectMatches(text: string, re: RegExp, separator: string): DatelineMatch[] {
  const out: DatelineMatch[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      apostrophe: m[1],
      separator,
      year: m[2],
      month: m[3],
      day: m[4],
    });
    // Guard against zero-length matches looping forever (cannot happen here,
    // but keeps the shared helper safe).
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

/**
 * Replaces every fingerprinted dateline sentence in `text` with its canonical
 * form. Returns the rewritten text and the hits observed; when nothing
 * matches the original string is returned verbatim and hits is empty.
 */
export function normalizeDatelineText(text: string): { text: string; hits: DatelineHit[] } {
  if (!text.includes("date is ")) return { text, hits: [] };
  const matches = [
    ...collectMatches(text, DATELINE_HYPHEN, "-"),
    ...collectMatches(text, DATELINE_SLASH, "/"),
  ];
  if (matches.length === 0) return { text, hits: [] };
  matches.sort((a, b) => a.start - b.start);

  let out = "";
  let prev = 0;
  const hits: DatelineHit[] = [];
  let changed = false;
  for (const m of matches) {
    const canonical = canonicalize(m.year, m.month, m.day);
    if (text.slice(m.start, m.end) === canonical) continue; // already canonical
    out += text.slice(prev, m.start) + canonical;
    prev = m.end;
    changed = true;
    hits.push({ apostropheVariant: apostropheVariant(m.apostrophe), dateSeparator: m.separator });
  }
  if (!changed) return { text, hits: [] };
  return { text: out + text.slice(prev), hits };
}

/**
 * Scans only the <system-reminder> blocks inside `text`. Text outside the
 * blocks is preserved byte-for-byte, so user prose, tool_result content, code
 * blocks, or shell commands that mention a date are never touched.
 */
function normalizeSystemReminderScopedText(text: string): { text: string; hits: DatelineHit[] } {
  if (!text.includes("<system-reminder>")) return { text, hits: [] };
  SYSTEM_REMINDER.lastIndex = 0;
  let out = "";
  let prev = 0;
  const hits: DatelineHit[] = [];
  let changed = false;
  let m: RegExpExecArray | null;
  while ((m = SYSTEM_REMINDER.exec(text)) !== null) {
    out += text.slice(prev, m.index);
    const block = m[0];
    const normalized = normalizeDatelineText(block);
    if (normalized.text !== block) changed = true;
    out += normalized.text;
    hits.push(...normalized.hits);
    prev = m.index + block.length;
    if (block.length === 0) SYSTEM_REMINDER.lastIndex++;
  }
  if (!changed) return { text, hits: [] };
  return { text: out + text.slice(prev), hits };
}

function getPath(obj: unknown, path: (string | number)[]): unknown {
  let cur = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, path: (string | number)[], value: unknown): void {
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const next = (cur as Record<string | number, unknown>)[path[i]];
    if (next === null || typeof next !== "object") return;
    cur = next as Record<string, unknown>;
  }
  (cur as Record<string | number, unknown>)[path[path.length - 1]] = value;
}

/**
 * Scans an Anthropic /v1/messages request body (as a JSON string) and rewrites
 * every fingerprinted dateline sentence back to canonical ASCII form.
 *
 * Scope (mirroring where genuine clients place the sentence):
 *  - `system` string, or the `.text` of each text-typed block in `system`.
 *  - Text inside `messages[i].content` — but ONLY substrings inside
 *    `<system-reminder>...</system-reminder>` tags. Free user prose,
 *    tool_use.input, tool_result.content and other block types are never
 *    scanned.
 *
 * Pure transform: never mutates the input; when no rewrite is needed the
 * input string is returned verbatim with changed=false.
 */
export function normalizeDatelineBody(body: string): NormalizeDatelineResult {
  if (!body || !body.includes("date is ")) return { body, hits: [], changed: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { body, hits: [], changed: false };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { body, hits: [], changed: false };
  }
  const root = parsed as Record<string, unknown>;
  const hits: DatelineHit[] = [];
  let changed = false;

  const applyText = (value: unknown, path: (string | number)[], scoped: boolean): void => {
    if (typeof value !== "string") return;
    const normalized = scoped
      ? normalizeSystemReminderScopedText(value)
      : normalizeDatelineText(value);
    if (normalized.text !== value) {
      setPath(root, path, normalized.text);
      changed = true;
      hits.push(...normalized.hits);
    }
  };

  const system = getPath(root, ["system"]);
  if (typeof system === "string") {
    applyText(system, ["system"], false);
  } else if (Array.isArray(system)) {
    system.forEach((block, i) => {
      if (
        block !== null && typeof block === "object" && !Array.isArray(block) &&
        (block as Record<string, unknown>).type === "text"
      ) {
        applyText(getPath(root, ["system", i, "text"]), ["system", i, "text"], false);
      }
    });
  }

  const messages = getPath(root, ["messages"]);
  if (Array.isArray(messages)) {
    messages.forEach((msg, msgIdx) => {
      if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return;
      const content = (msg as Record<string, unknown>).content;
      if (typeof content === "string") {
        applyText(content, ["messages", msgIdx, "content"], true);
      } else if (Array.isArray(content)) {
        content.forEach((block, blockIdx) => {
          if (
            block !== null && typeof block === "object" && !Array.isArray(block) &&
            (block as Record<string, unknown>).type === "text"
          ) {
            applyText(
              getPath(root, ["messages", msgIdx, "content", blockIdx, "text"]),
              ["messages", msgIdx, "content", blockIdx, "text"],
              true,
            );
          }
        });
      }
    });
  }

  if (!changed) return { body, hits: [], changed: false };
  return { body: JSON.stringify(root), hits, changed: true };
}
