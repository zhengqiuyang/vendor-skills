import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { countSummary, validateSkillDir } from "../src/validate.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EXAMPLES = join(PROJECT_ROOT, "example-skills");

interface Fixture {
  fm: string;
  body: string;
  files?: string[];
  dirName?: string;
}

/** Create a throwaway skill directory in os.tmpdir() and return its path. */
async function makeSkill(fixture: Fixture): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "vendor-skills-validate-"));
  const dir = join(base, fixture.dirName ?? "test-skill");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\n${fixture.fm}\n---\n${fixture.body}`, "utf8");
  for (const rel of fixture.files ?? []) {
    const target = join(dir, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "", "utf8");
  }
  return dir;
}

const codesOf = (diags: Awaited<ReturnType<typeof validateSkillDir>>["diagnostics"]): string[] =>
  diags.map((d) => d.code);

test("validate: pdf-helper example is fully valid", async () => {
  const result = await validateSkillDir(join(EXAMPLES, "pdf-helper"));
  assert.equal(countSummary(result.diagnostics).errors, 0);
  assert.equal(countSummary(result.diagnostics).warnings, 0);
  assert.ok(result.valid);
  assert.equal(result.name, "pdf-helper");
});

test("validate: broken-skill example has the expected error codes", async () => {
  const result = await validateSkillDir(join(EXAMPLES, "broken-skill"));
  const codes = codesOf(result.diagnostics);
  assert.ok(!result.valid);
  assert.ok(codes.includes("SKILL_NAME_INVALID"), `expected SKILL_NAME_INVALID in ${codes}`);
  assert.ok(codes.includes("SKILL_NAME_MISMATCH"), `expected SKILL_NAME_MISMATCH in ${codes}`);
  assert.ok(codes.includes("SKILL_DESCRIPTION_MISSING"), `expected SKILL_DESCRIPTION_MISSING in ${codes}`);
  assert.ok(codes.includes("SKILL_UNKNOWN_KEYS"), `expected SKILL_UNKNOWN_KEYS in ${codes}`);
  const { errors, warnings } = countSummary(result.diagnostics);
  assert.ok(errors >= 3, `expected at least 3 errors, got ${errors}`);
  assert.ok(warnings >= 1);
});

test("validate: missing SKILL.md", async () => {
  const base = await mkdtemp(join(tmpdir(), "vendor-skills-validate-"));
  const result = await validateSkillDir(base);
  assert.ok(!result.valid);
  assert.ok(codesOf(result.diagnostics).includes("SKILL_MD_MISSING"));
});

test("validate: missing name", async () => {
  const dir = await makeSkill({ fm: "description: Use when testing names", body: "Body text.\n" });
  const result = await validateSkillDir(dir);
  assert.ok(codesOf(result.diagnostics).includes("SKILL_NAME_MISSING"));
  assert.ok(!result.valid);
});

test("validate: name longer than 64 characters", async () => {
  const long = "a".repeat(65);
  const dir = await makeSkill({ fm: `name: ${long}\ndescription: Use when testing`, body: "Body text.\n" });
  const result = await validateSkillDir(dir);
  assert.ok(codesOf(result.diagnostics).includes("SKILL_NAME_TOO_LONG"));
});

test("validate: description shorter than 20 chars is a warning, not an error", async () => {
  const dir = await makeSkill({ fm: "name: test-skill\ndescription: short", body: "Body text.\n" });
  const result = await validateSkillDir(dir);
  const codes = codesOf(result.diagnostics);
  assert.ok(codes.includes("SKILL_DESCRIPTION_SHORT"));
  assert.ok(codes.includes("SKILL_DESCRIPTION_NO_TRIGGER"));
  assert.equal(countSummary(result.diagnostics).errors, 0);
  assert.ok(result.valid, "short description alone must not invalidate the skill");
});

test("validate: description longer than 1024 chars is an error", async () => {
  const dir = await makeSkill({
    fm: `name: test-skill\ndescription: ${"x".repeat(1025)}`,
    body: "Body text.\n",
  });
  const result = await validateSkillDir(dir);
  assert.ok(codesOf(result.diagnostics).includes("SKILL_DESCRIPTION_TOO_LONG"));
  assert.ok(!result.valid);
});

test("validate: empty body is an error", async () => {
  const dir = await makeSkill({ fm: "name: test-skill\ndescription: Use when testing", body: "\n   \n" });
  const result = await validateSkillDir(dir);
  assert.ok(codesOf(result.diagnostics).includes("SKILL_BODY_EMPTY"));
  assert.ok(!result.valid);
});

test("validate: body over 5000 words is a warning", async () => {
  const body = `${"word ".repeat(5001)}\n`;
  const dir = await makeSkill({ fm: "name: test-skill\ndescription: Use when testing", body });
  const result = await validateSkillDir(dir);
  assert.ok(codesOf(result.diagnostics).includes("SKILL_BODY_TOO_LONG"));
  assert.equal(countSummary(result.diagnostics).errors, 0);
});

test("validate: markdown links and backtick paths to missing files warn", async () => {
  const dir = await makeSkill({
    fm: "name: test-skill\ndescription: Use when testing refs",
    body: "Run `scripts/helper.py` first.\n\nSee the [guide](references/guide.md).\n",
    files: ["scripts/.keep"], // scripts/ exists, helper.py does not
  });
  const result = await validateSkillDir(dir);
  const missingRefs = result.diagnostics.filter((d) => d.code === "SKILL_MISSING_REF");
  assert.equal(missingRefs.length, 2, `expected 2 SKILL_MISSING_REF warnings, got ${missingRefs.length}`);
  assert.equal(countSummary(result.diagnostics).errors, 0);
});

test("validate: existing references do not warn", async () => {
  const dir = await makeSkill({
    fm: "name: test-skill\ndescription: Use when testing refs",
    body: "Run `scripts/helper.py`, see [guide](references/guide.md).\n",
    files: ["scripts/helper.py", "references/guide.md"],
  });
  const result = await validateSkillDir(dir);
  assert.deepEqual(result.diagnostics, []);
});

test("validate: remote links and anchors are not file references", async () => {
  const dir = await makeSkill({
    fm: "name: test-skill\ndescription: Use when testing refs",
    body: "See [npm](https://www.npmjs.com) and the [section](#section) below.\n",
  });
  const result = await validateSkillDir(dir);
  assert.deepEqual(result.diagnostics, []);
});

test("validate: name must equal the directory name unless explicitly ignored", async () => {
  const dir = await makeSkill({
    fm: "name: other-name\ndescription: Use when testing",
    body: "Body.\n",
    dirName: "test-skill",
  });
  const mismatched = await validateSkillDir(dir);
  assert.ok(codesOf(mismatched.diagnostics).includes("SKILL_NAME_MISMATCH"));

  const ignored = await validateSkillDir(dir, { ignoreDirNameMismatch: true });
  assert.equal(countSummary(ignored.diagnostics).errors, 0);
  assert.ok(ignored.valid);
});

test("validate: diagnostic lines point into the file", async () => {
  const dir = await makeSkill({ fm: "name: test-skill\ndescription: short", body: "Body.\n" });
  const result = await validateSkillDir(dir);
  const short = result.diagnostics.find((d) => d.code === "SKILL_DESCRIPTION_SHORT");
  assert.ok(short);
  assert.equal(short.line, 3, "'description' sits on raw line 2, i.e. file line 3");
  const mismatch = result.diagnostics.find((d) => d.code === "SKILL_NAME_MISSING");
  assert.equal(mismatch, undefined);
});
