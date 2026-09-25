import { expect, test } from "bun:test";
import { normalizeDatelineBody, normalizeDatelineText } from "../src/antidetect/dateline";

test("already-canonical dateline is byte-identical", () => {
  const text = `Remember: Today's date is 2026-09-26. Do the task.`;
  const { text: out, hits } = normalizeDatelineText(text);
  expect(out).toBe(text);
  expect(hits).toEqual([]);
});

test("u2019 apostrophe variant is normalized with a hit", () => {
  const { text, hits } = normalizeDatelineText(`Note: Today\u2019s date is 2026-09-26.`);
  expect(text).toBe(`Note: Today's date is 2026-09-26.`);
  expect(hits).toEqual([{ apostropheVariant: "u2019", dateSeparator: "-" }]);
});

test("slash date separator is normalized", () => {
  const { text, hits } = normalizeDatelineText(`Today's date is 2026/09/26.`);
  expect(text).toBe(`Today's date is 2026-09-26.`);
  expect(hits).toEqual([{ apostropheVariant: "ascii", dateSeparator: "/" }]);
});

test("u02bc and u02b9 apostrophes are normalized", () => {
  const { text, hits } = normalizeDatelineText(`Today\u02bcs date is 2026-09-26. and Today\u02b9s date is 2026-09-26.`);
  expect(text).toBe(`Today's date is 2026-09-26. and Today's date is 2026-09-26.`);
  expect(hits.map((h) => h.apostropheVariant)).toEqual(["u02bc", "u02b9"]);
});

test("mixed separators never match", () => {
  const text = `Today's date is 2026-09/26.`;
  expect(normalizeDatelineText(text).text).toBe(text);
});

test("user prose without the full sentence is untouched", () => {
  for (const text of [`Today is foo.`, `His date is 2026-06-30.`, `Today's date is unknown.`]) {
    expect(normalizeDatelineText(text).text).toBe(text);
  }
});

test("system string scope is normalized", () => {
  const body = JSON.stringify({
    model: "claude-opus-4-5",
    system: `You are helpful. Today\u2019s date is 2026-09-26.`,
    messages: [],
  });
  const { body: out, changed, hits } = normalizeDatelineBody(body);
  expect(changed).toBe(true);
  expect(hits).toHaveLength(1);
  expect(JSON.parse(out).system).toBe(`You are helpful. Today's date is 2026-09-26.`);
});

test("system array text blocks are normalized", () => {
  const body = JSON.stringify({
    system: [{ type: "text", text: `Today's date is 2026/09/26.` }, { type: "other", text: `Today's date is 2026/09/26.` }],
    messages: [],
  });
  const { body: out, changed } = normalizeDatelineBody(body);
  expect(changed).toBe(true);
  const parsed = JSON.parse(out);
  expect(parsed.system[0].text).toBe(`Today's date is 2026-09-26.`);
  expect(parsed.system[1].text).toBe(`Today's date is 2026/09/26.`); // non-text block untouched
});

test("message content is only normalized inside system-reminder tags", () => {
  const body = JSON.stringify({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `Please write an essay about Today's date is 2026-09-26.` },
          { type: "text", text: `<system-reminder>Today\u2019s date is 2026-09-26. Stay on task.</system-reminder>` },
          { type: "tool_result", content: `Today\u2019s date is 2026-09-26.` },
        ],
      },
      { role: "user", content: `<system-reminder>Today's date is 2026/09/26.</system-reminder>` },
    ],
  });
  const { body: out, changed, hits } = normalizeDatelineBody(body);
  expect(changed).toBe(true);
  expect(hits).toHaveLength(2);
  const parsed = JSON.parse(out);
  // Free user prose untouched even though it contains the sentence shape.
  expect(parsed.messages[0].content[0].text).toBe(`Please write an essay about Today's date is 2026-09-26.`);
  // Inside system-reminder: normalized.
  expect(parsed.messages[0].content[1].text).toBe(`<system-reminder>Today's date is 2026-09-26. Stay on task.</system-reminder>`);
  // tool_result blocks never scanned.
  expect(parsed.messages[0].content[2].content).toBe(`Today\u2019s date is 2026-09-26.`);
  // String content form: only the tagged part rewritten.
  expect(parsed.messages[1].content).toBe(`<system-reminder>Today's date is 2026-09-26.</system-reminder>`);
});

test("text outside system-reminder in a string content is preserved byte-for-byte", () => {
  const body = JSON.stringify({
    messages: [{ role: "user", content: `run: echo Today\u2019s date is 2026-09-26` }],
  });
  const { changed } = normalizeDatelineBody(body);
  expect(changed).toBe(false);
});

test("invalid JSON and empty bodies pass through unchanged", () => {
  expect(normalizeDatelineBody("not json {").changed).toBe(false);
  expect(normalizeDatelineBody("").changed).toBe(false);
  expect(normalizeDatelineBody("[]").changed).toBe(false);
});

test("normalizeDatelineBody never mutates when nothing matches", () => {
  const body = JSON.stringify({ system: "hello", messages: [{ role: "user", content: "hi" }] });
  const result = normalizeDatelineBody(body);
  expect(result.changed).toBe(false);
  expect(result.body).toBe(body);
});
