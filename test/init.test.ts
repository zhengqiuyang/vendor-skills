import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { scaffoldSkill } from "../src/cli.js";
import { validateSkillDir } from "../src/validate.js";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI_JS = join(PROJECT_ROOT, "dist", "src", "cli.js");

test("init: scaffolded template validates with zero diagnostics", async () => {
  const parent = await mkdtemp(join(tmpdir(), "vendor-skills-init-"));
  const { dir } = await scaffoldSkill("demo-skill", parent);
  assert.ok(existsSync(join(dir, "SKILL.md")), "SKILL.md should exist");
  assert.ok(existsSync(join(dir, "README.md")), "README.md should exist");

  const result = await validateSkillDir(dir);
  assert.deepEqual(
    result.diagnostics.map((d) => `${d.level}:${d.code}`),
    [],
    "the scaffold template must be clean: no errors, no warnings",
  );

  const text = await readFile(join(dir, "SKILL.md"), "utf8");
  assert.match(text, /^---\nname: demo-skill\n/m);
  assert.match(text, /## Overview[\s\S]*## When to use[\s\S]*## Instructions[\s\S]*## Files/);
});

test("init: refuses invalid skill names", async () => {
  const parent = await mkdtemp(join(tmpdir(), "vendor-skills-init-"));
  for (const bad of ["Bad_Name", "UPPER", "has space", "-leading", "trailing-", "with.dot", ""]) {
    await assert.rejects(scaffoldSkill(bad, parent), /name/i);
  }
});

test("init: refuses to overwrite an existing skill", async () => {
  const parent = await mkdtemp(join(tmpdir(), "vendor-skills-init-"));
  await scaffoldSkill("twice-skill", parent);
  await assert.rejects(scaffoldSkill("twice-skill", parent), /refusing to overwrite/i);
});

test("cli: --help prints usage, new commands included, and exits 0", async () => {
  const { stdout } = await execFileAsync(process.execPath, [CLI_JS, "--help"]);
  assert.match(stdout, /Usage:/);
  assert.match(stdout, /init <name>/);
  assert.match(stdout, /install <git-url>/);
  assert.match(stdout, /--frozen/);
  assert.match(stdout, /update \[name \.\.\.\]/);
  assert.match(stdout, /verify/);
  assert.match(stdout, /\.agents\/skills/);
});

test("cli: unknown command prints help and exits 2", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [CLI_JS, "frobnicate"]),
    (err: NodeJS.ErrnoException & { code?: number | string; stderr?: string }) =>
      Number(err.code) === 2 && String(err.stderr).includes("unknown command"),
  );
});

test("cli: bad init name exits 2 with a clear message", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "vendor-skills-cwd-"));
  await assert.rejects(
    execFileAsync(process.execPath, [CLI_JS, "init", "Bad_Name"], { cwd }),
    (err: NodeJS.ErrnoException & { code?: number | string; stderr?: string }) =>
      Number(err.code) === 2 && String(err.stderr).includes("invalid skill name"),
  );
  assert.ok(!existsSync(join(cwd, ".agents")), "a rejected init must not create the skills root");
});

test("cli: init/validate/list default to the .agents/skills root", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "vendor-skills-cwd-"));

  const init = await execFileAsync(process.execPath, [CLI_JS, "init", "demo-skill"], { cwd });
  assert.match(init.stdout, /Created skill skeleton:/);
  assert.ok(existsSync(join(cwd, ".agents", "skills", "demo-skill", "SKILL.md")), "init must scaffold into .agents/skills");
  assert.ok(!existsSync(join(cwd, "demo-skill")), "init must NOT scaffold into the project root");

  const validate = await execFileAsync(process.execPath, [CLI_JS, "validate"], { cwd });
  assert.match(validate.stdout, /demo-skill/);

  const list = await execFileAsync(process.execPath, [CLI_JS, "list"], { cwd });
  assert.match(list.stdout, /demo-skill/);
  assert.ok(existsSync(join(cwd, ".agents", "skills")), "the root is created on demand");
});

test("cli: install --frozen without a lockfile exits 2", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "vendor-skills-cwd-"));
  await assert.rejects(
    execFileAsync(process.execPath, [CLI_JS, "install", "https://example.com/skills/repo.git", "--frozen"], { cwd }),
    (err: NodeJS.ErrnoException & { code?: number | string; stderr?: string }) =>
      Number(err.code) === 2 && /--frozen requires a lockfile/i.test(String(err.stderr)),
  );
});

test("cli: update --frozen is rejected as a usage error (exit 2)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "vendor-skills-cwd-"));
  await assert.rejects(
    execFileAsync(process.execPath, [CLI_JS, "update", "--frozen"], { cwd }),
    (err: NodeJS.ErrnoException & { code?: number | string; stderr?: string }) =>
      Number(err.code) === 2 && /mutually exclusive/i.test(String(err.stderr)),
  );
});

test("cli: verify without a lockfile exits 1 with guidance", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "vendor-skills-cwd-"));
  await assert.rejects(
    execFileAsync(process.execPath, [CLI_JS, "verify"], { cwd }),
    (err: NodeJS.ErrnoException & { code?: number | string; stderr?: string }) =>
      Number(err.code) === 1 && /nothing to verify/i.test(String(err.stderr)),
  );
});
