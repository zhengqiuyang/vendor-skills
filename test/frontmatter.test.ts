import assert from "node:assert/strict";
import { test } from "node:test";
import { FrontmatterError, parse, serialize } from "../src/frontmatter.js";
import type { ParsedSkillMarkdown } from "../src/frontmatter.js";

function tryParse(text: string): { parsed?: ParsedSkillMarkdown; err?: FrontmatterError } {
  try {
    return { parsed: parse(text) };
  } catch (e) {
    assert.ok(e instanceof FrontmatterError, `expected FrontmatterError, got: ${String(e)}`);
    return { err: e as FrontmatterError };
  }
}

test("frontmatter: parses name, description, body, fences", () => {
  const { parsed } = tryParse("---\nname: my-skill\ndescription: Use when parsing files\n---\n\nBody line 1\nBody line 2\n");
  assert.ok(parsed);
  assert.equal(parsed.data.name, "my-skill");
  assert.equal(parsed.data.description, "Use when parsing files");
  assert.equal(parsed.body.trim(), "Body line 1\nBody line 2");
  assert.deepEqual(parsed.fences, { start: 1, end: 4 });
  assert.match(parsed.raw, /^name: my-skill$/m);
});

test("frontmatter: body-only file has no opening fence", () => {
  const { err } = tryParse("# Just a heading\n\nNo frontmatter here.\n");
  assert.ok(err);
  assert.equal(err.code, "FM_MISSING_OPENING_FENCE");
});

test("frontmatter: missing closing fence", () => {
  const { err } = tryParse("---\nname: my-skill\n");
  assert.ok(err);
  assert.equal(err.code, "FM_MISSING_CLOSING_FENCE");
});

test("frontmatter: empty frontmatter must contain name", () => {
  const { err } = tryParse("---\n---\nBody\n");
  assert.ok(err);
  assert.equal(err.code, "FM_EMPTY_FRONTMATTER");
  assert.match(err.message, /name/);
});

test("frontmatter: whitespace-only frontmatter is also empty", () => {
  const { err } = tryParse("---\n   \n---\nBody\n");
  assert.ok(err);
  assert.equal(err.code, "FM_EMPTY_FRONTMATTER");
});

test("frontmatter: invalid YAML reports the file line number", () => {
  // 'description: a: b' is a nested mapping on raw line 2, i.e. file line 3.
  const { err } = tryParse("---\nname: foo\ndescription: a: b\n---\nBody\n");
  assert.ok(err);
  assert.equal(err.code, "FM_INVALID_YAML");
  assert.equal(err.line, 3);
  assert.match(err.message, /line 3/);
});

test("frontmatter: non-mapping frontmatter is rejected", () => {
  const { err } = tryParse("---\n- one\n- two\n---\nBody\n");
  assert.ok(err);
  assert.equal(err.code, "FM_NOT_MAPPING");
});

test("frontmatter: CRLF line endings are handled (Windows)", () => {
  const text = "---\r\nname: win-skill\r\ndescription: Use when on Windows\r\n---\r\n\r\nLine one\r\nLine two\r\n";
  const { parsed } = tryParse(text);
  assert.ok(parsed);
  assert.equal(parsed.data.name, "win-skill");
  assert.equal(parsed.data.description, "Use when on Windows");
  assert.ok(!parsed.body.includes("\r"), "body must be LF-normalized");
  assert.equal(parsed.body.trim(), "Line one\nLine two");
  assert.deepEqual(parsed.fences, { start: 1, end: 4 });
});

test("frontmatter: leading UTF-8 BOM is tolerated", () => {
  const { parsed } = tryParse("﻿---\nname: bom-skill\ndescription: Use when testing BOMs\n---\nBody\n");
  assert.ok(parsed);
  assert.equal(parsed.data.name, "bom-skill");
});

test("frontmatter: file that is only frontmatter has an empty body", () => {
  const { parsed } = tryParse("---\nname: empty-body\ndescription: Use when testing\n---");
  assert.ok(parsed);
  assert.equal(parsed.body, "");
});

test("frontmatter: a horizontal rule in the body is not confused with fences", () => {
  const { parsed } = tryParse("---\nname: hr-skill\ndescription: Use when testing\n---\nIntro\n\n---\n\nAfter the rule\n");
  assert.ok(parsed);
  assert.equal(parsed.fences.end, 4);
  assert.match(parsed.body, /After the rule/);
});

test("serialize: canonical roundtrip", () => {
  const text = serialize({ name: "rt-skill", description: "Use when roundtripping" }, "Hello\n");
  const { parsed } = tryParse(text);
  assert.ok(parsed);
  assert.equal(parsed.data.name, "rt-skill");
  assert.equal(parsed.data.description, "Use when roundtripping");
  assert.equal(parsed.body.trim(), "Hello");
});

test("serialize: blank line after the fence and a final newline", () => {
  const text = serialize({ name: "rt-skill" }, "No trailing newline");
  assert.ok(text.endsWith("\n"));
  assert.ok(text.includes("---\nname: rt-skill\n---\n\nNo trailing newline\n"));
});

test("serialize: empty body produces frontmatter only", () => {
  const text = serialize({ name: "rt-skill" }, "");
  assert.equal(text, "---\nname: rt-skill\n---\n");
});
