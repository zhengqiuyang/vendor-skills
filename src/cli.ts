#!/usr/bin/env node
/**
 * vendor-skills - the vendoring tool for Agent Skills (SKILL.md).
 *
 * Commands: init, validate, list, install (--frozen), update, verify,
 * uninstall. Hand-rolled argument parsing and ANSI colors - zero runtime
 * dependencies beyond `yaml`.
 */
import { existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serialize } from "./frontmatter.js";
import { countSummary, validateSkillDir, NAME_PATTERN, NAME_MAX_LENGTH } from "./validate.js";
import type { Diagnostic } from "./validate.js";
import { findSkillDirs, resolveSkillsRoot, scanSkills } from "./skills-dir.js";
import { installSkill, installSkillFrozen, uninstallSkill, updateSkills } from "./git.js";
import type { SkillUpdate } from "./git.js";
import { verifySkills } from "./verify.js";
import { lockPath } from "./lock.js";
import { UsageError } from "./errors.js";

const VERSION = "0.2.0";
const BIN = "vendor-skills";

// ---------------------------------------------------------------- colors ---

const colorEnabled = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
function colorFn(code: string): (s: string) => string {
  return (s) => (colorEnabled ? `\u001b[${code}m${s}\u001b[0m` : s);
}
const green = colorFn("32");
const red = colorFn("31");
const yellow = colorFn("33");
const cyan = colorFn("36");
const bold = colorFn("1");
const dim = colorFn("2");

// ------------------------------------------------------------------ help ---

const HELP = `${BIN} v${VERSION} - the vendoring tool for Agent Skills (SKILL.md)

Pinned, validated, reproducible, offline skills from any git remote into .agents/skills.

Usage:
  ${BIN} <command> [options]

Commands:
  init <name>               Scaffold <name>/SKILL.md into the skills root (default ./.agents/skills)
  validate [path]           Validate a skill directory, or scan a root for skills (default: ./.agents/skills)
  list [path]               List skills found under a root (default: ./.agents/skills)
  install <git-url>         Clone a git repo, validate, install the skill it contains, pin the commit
  install [<name>] --frozen Restore exactly the pinned commit from vendor-skills.lock (never writes the lock;
                            with no name: restore every pinned skill, like npm ci)
  update [name ...]         Re-clone at the latest HEAD, validate, and re-pin (all locked skills when no name given)
  verify                    CI check: every lock entry present + valid; untracked dirs are warnings
  uninstall <name>          Remove an installed skill and its lockfile entry

Options:
  --path <dir>              Skills root directory (default: ./.agents/skills, created on demand)
  --subdir <path>           (install) repository subdirectory containing the skill
  --force                   (install) replace an already-installed skill
  -h, --help                Show this help
  --version                 Show the ${BIN} version

Exit codes:
  0 success | 1 validation or runtime failure | 2 usage error

Examples:
  ${BIN} init my-skill
  ${BIN} validate
  ${BIN} list
  ${BIN} install https://github.com/example/skills --subdir pdf-helper
  ${BIN} install --frozen                  # restore every pinned skill, exactly (CI)
  ${BIN} update pdf-helper                 # bump to the latest commit
  ${BIN} verify                            # gate: pinned skills present and valid`;

function printHelp(): void {
  console.log(HELP);
}

// ----------------------------------------------------------------- table ---

interface Cell {
  text: string;
  color?: (s: string) => string;
}

function printTable(headers: string[], rows: Cell[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.text.length ?? 0)));
  const last = widths.length - 1;
  const pad = (s: string, w: number, isLast: boolean) => (isLast ? s : s.padEnd(w));
  console.log(
    bold(headers.map((h, i) => pad(h, widths[i], i === last)).join("  ")),
  );
  console.log(dim(widths.map((w) => "-".repeat(w)).join("  ")));
  for (const row of rows) {
    console.log(
      row
        .map((c, i) => {
          const padded = pad(c.text, widths[i], i === last);
          return c.color ? c.color(padded) : padded;
        })
        .join("  "),
    );
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
}

// ------------------------------------------------------------------ init ---

const TEMPLATE_DESCRIPTION =
  "TODO: describe what this skill does and when to use it (one or two sentences, 20-1024 characters).";

function bodyTemplate(name: string): string {
  return `# ${name}

## Overview

Describe what this skill does in one or two sentences.

## When to use

Describe the situations in which an agent should load this skill. Mention
concrete trigger phrases or task types so the skill is discovered reliably.

## Instructions

1. First step the agent should follow.
2. Second step.
3. Keep each step imperative and concrete; prefer checklists over prose.

## Files

- SKILL.md - this file: YAML frontmatter (name, description) plus instructions.
- scripts/ - optional helper scripts. Create this directory if you add any.
- references/ - optional long-form reference documents. Create if needed.

After editing, run \`${BIN} validate ${name}\` to check the result.
`;
}

function readmeTemplate(name: string): string {
  return `# ${name}

An Agent Skill managed with ${BIN}.

## Layout

- SKILL.md - the skill itself: YAML frontmatter (name, description) plus the
  instruction body shown to the agent.
- scripts/ - optional executable helpers (create when needed).
- references/ - optional long-form reference documents (create when needed).

## Checklist

1. Replace the TODO description with 1-2 sentences saying what the skill does
   and when to use it.
2. Fill in the body sections in SKILL.md.
3. Run \`${BIN} validate ${name}\` until it passes with zero errors.
`;
}

/** Validate a skill name before any directory is created (exported for tests). */
export function assertValidSkillName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new UsageError(`init requires a skill name, e.g. '${BIN} init my-skill'`);
  }
  if (name.length > NAME_MAX_LENGTH) {
    throw new UsageError(`invalid skill name "${name}": must be at most ${NAME_MAX_LENGTH} characters`);
  }
  if (!NAME_PATTERN.test(name)) {
    throw new UsageError(
      `invalid skill name "${name}": must match ${NAME_PATTERN.source} (lowercase kebab-case: letters, digits, hyphens)`,
    );
  }
}

/** Scaffold a new skill directory (exported for tests). */
export async function scaffoldSkill(name: string, parentDir: string): Promise<{ dir: string; files: string[] }> {
  assertValidSkillName(name);
  const dir = join(parentDir, name);
  const skillMdPath = join(dir, "SKILL.md");
  if (existsSync(skillMdPath)) {
    throw new Error(`refusing to overwrite: ${skillMdPath} already exists`);
  }
  await mkdir(dir, { recursive: true });
  await writeFile(skillMdPath, serialize({ name, description: TEMPLATE_DESCRIPTION }, bodyTemplate(name)), "utf8");
  const readmePath = join(dir, "README.md");
  await writeFile(readmePath, readmeTemplate(name), "utf8");
  return { dir, files: [skillMdPath, readmePath] };
}

async function cmdInit(name: string, pathFlag: string | undefined): Promise<void> {
  assertValidSkillName(name); // reject bad names before creating anything on disk
  const root = await resolveSkillsRoot(pathFlag);
  const { dir, files } = await scaffoldSkill(name, root);
  console.log(green(`Created skill skeleton:`) + ` ${relative(process.cwd(), dir) || dir}`);
  for (const f of files) {
    console.log(`  ${dim(f)}`);
  }
  console.log(`\nNext: edit SKILL.md, then run ${cyan(`${BIN} validate ${name}`)}.`);
}

// -------------------------------------------------------------- validate ---

async function cmdValidate(positional: string | undefined, pathFlag: string | undefined): Promise<void> {
  let target: string;
  let targetIsFile = false;
  if (positional !== undefined || pathFlag !== undefined) {
    target = resolve(positional ?? pathFlag!);
    const st = await stat(target).catch(() => null);
    if (st === null) {
      throw new Error(`path not found: ${target}`);
    }
    targetIsFile = st.isFile();
  } else {
    target = await resolveSkillsRoot(); // default .agents/skills, created on demand
  }

  let skillDirs: string[];
  if (targetIsFile) {
    if (basename(target) !== "SKILL.md") {
      throw new Error(`expected a skill directory or a SKILL.md file, but got: ${target}`);
    }
    skillDirs = [dirname(target)];
  } else if (existsSync(join(target, "SKILL.md"))) {
    skillDirs = [target];
  } else {
    skillDirs = await findSkillDirs(target);
    if (skillDirs.length === 0) {
      console.log(`No SKILL.md found under ${target} (searched up to 3 levels, skipping node_modules and .git).`);
      return;
    }
  }

  const rows = [];
  for (const dir of skillDirs) {
    const result = await validateSkillDir(dir);
    const { errors, warnings } = countSummary(result.diagnostics);
    rows.push({
      dir,
      name: result.name ?? basename(dir),
      errors,
      warnings,
      codes: result.diagnostics.map((d) => d.code).join(", "),
      diagnostics: result.diagnostics,
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));

  printTable(
    ["NAME", "STATUS", "ERRORS", "WARNINGS", "CODES"],
    rows.map((r) => [
      { text: r.name },
      { text: r.errors > 0 ? "\u2717 invalid" : "\u2713 ok", color: r.errors > 0 ? red : green },
      { text: String(r.errors), color: r.errors > 0 ? red : undefined },
      { text: String(r.warnings), color: r.warnings > 0 ? yellow : undefined },
      { text: r.codes || "-" },
    ]),
  );

  for (const row of rows) {
    if (row.diagnostics.length === 0) continue;
    console.log(`\n${bold(row.dir)}:`);
    for (const d of row.diagnostics) {
      const tag = d.level === "error" ? red(`[${d.level}]`) : yellow(`[${d.level}]`);
      const where = d.line !== undefined ? dim(` (line ${d.line})`) : "";
      console.log(`  ${tag} ${d.code}: ${d.message}${where}`);
    }
  }

  const invalid = rows.filter((r) => r.errors > 0).length;
  const totalWarnings = rows.reduce((n, r) => n + r.warnings, 0);
  console.log(
    `\n${rows.length} skill(s): ${green(`${rows.length - invalid} valid`)}, ${invalid > 0 ? red(`${invalid} with errors`) : `${invalid} with errors`}, ${totalWarnings} warning(s)`,
  );
  if (invalid > 0) {
    process.exitCode = 1;
  }
}

// ------------------------------------------------------------------ list ---

async function cmdList(positional: string | undefined, pathFlag: string | undefined): Promise<void> {
  const root = await resolveSkillsRoot(positional ?? pathFlag);
  const entries = await scanSkills(root);
  if (entries.length === 0) {
    console.log(`No skills found under ${root}.`);
    console.log(dim(`Create one with '${BIN} init <name>', or vendor one with '${BIN} install <git-url>'.`));
    return;
  }
  printTable(
    ["NAME", "STATUS", "ERRORS", "WARNINGS", "DESCRIPTION", "PATH"],
    entries.map((e) => [
      { text: e.name },
      { text: e.valid ? "\u2713 ok" : "\u2717 invalid", color: e.valid ? green : red },
      { text: String(e.errorCount), color: e.errorCount > 0 ? red : undefined },
      { text: String(e.warningCount), color: e.warningCount > 0 ? yellow : undefined },
      { text: truncate(e.description, 48) },
      { text: relative(root, e.path) || "." },
    ]),
  );
  console.log(dim(`\n${entries.length} skill(s) under ${root}`));
}

// --------------------------------------------------------------- install ---

function printInstallWarnings(name: string, warnings: readonly Diagnostic[]): void {
  if (warnings.length > 0) {
    console.log(yellow(`${warnings.length} validation warning(s) for ${name}:`));
    for (const w of warnings) {
      console.log(yellow(`  ${w.code}: ${w.message}`));
    }
  }
}

async function cmdInstall(
  positional: string | undefined,
  flags: Record<string, string | boolean>,
): Promise<void> {
  const dest = await resolveSkillsRoot(flagString(flags, "path"));
  if (flags.frozen === true) {
    const subdir = flagString(flags, "subdir");
    if (subdir !== undefined) {
      throw new UsageError(`--subdir cannot be combined with --frozen: the lockfile already records where the skill lives.`);
    }
    const results = await installSkillFrozen(positional, { dest });
    for (const result of results) {
      console.log(
        green(`Restored ${bold(result.name)} @ ${result.commit.slice(0, 10)} (pinned)`) +
          dim(` -> ${relative(process.cwd(), result.dir) || result.dir}`),
      );
      printInstallWarnings(result.name, result.warnings);
    }
    console.log(dim(`Lockfile left untouched (--frozen): ${lockPath(dest)}`));
    return;
  }
  if (positional === undefined) {
    throw new UsageError(`usage: ${BIN} install <git-url> [--subdir <path>] [--force]\n  (or: ${BIN} install --frozen to restore every skill pinned in the lockfile)`);
  }
  console.log(dim(`Cloning ${positional} ...`));
  const result = await installSkill(positional, {
    dest,
    subdir: flagString(flags, "subdir"),
    force: flags.force === true,
  });
  console.log(
    green(`Installed ${bold(result.name)} @ ${result.commit.slice(0, 10)}`) +
      dim(` -> ${relative(process.cwd(), result.dir) || result.dir}`),
  );
  printInstallWarnings(result.name, result.warnings);
  console.log(dim(`Lockfile updated: ${lockPath(dest)}`));
}

async function cmdUninstall(name: string, flags: Record<string, string | boolean>): Promise<void> {
  const dest = await resolveSkillsRoot(flagString(flags, "path"));
  await uninstallSkill(name, { dest });
  console.log(green(`Uninstalled ${bold(name)}`) + dim(` from ${dest} (lockfile updated)`));
}

// ---------------------------------------------------------------- update ---

function printUpdate(update: SkillUpdate): void {
  const old = (update.oldCommit ?? "").slice(0, 7);
  const next = (update.newCommit ?? "").slice(0, 7);
  switch (update.outcome) {
    case "updated":
      console.log(green(`${update.name}: ${old} \u2192 ${next}`));
      return;
    case "up-to-date":
      console.log(`${update.name}: ${old} (already up to date)`);
      return;
    case "skipped":
      console.log(yellow(`${update.name}: skipped — ${update.message ?? "no lockfile entry"}`));
      return;
    case "failed":
      console.error(red(`${update.name}: update failed — ${update.message ?? "unknown error"}`));
      return;
  }
}

async function cmdUpdate(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  if (flags.frozen === true) {
    throw new UsageError(
      `--frozen and update are mutually exclusive: update re-pins the lockfile, --frozen forbids changing it.`,
    );
  }
  const dest = await resolveSkillsRoot(flagString(flags, "path"));
  console.log(dim(`Updating from the latest default branches ...`));
  const results = await updateSkills(positionals.length > 0 ? positionals : undefined, { dest });
  for (const r of results) {
    printUpdate(r);
  }
  const updated = results.filter((r) => r.outcome === "updated").length;
  const failed = results.filter((r) => r.outcome === "failed").length;
  if (updated > 0) {
    console.log(dim(`\nLockfile updated: ${lockPath(dest)}`));
  }
  if (failed > 0) {
    console.error(red(`\n${failed} skill(s) failed to update; the lockfile keeps their previous pins.`));
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------- verify ---

async function cmdVerify(flags: Record<string, string | boolean>): Promise<void> {
  const dest = await resolveSkillsRoot(flagString(flags, "path"));
  const report = await verifySkills(dest);

  const rows: Cell[][] = report.entries
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => [
      { text: e.name },
      { text: e.pinnedCommit.slice(0, 7) },
      {
        text: e.status === "ok" ? "\u2713 ok" : e.status === "missing" ? "\u2717 missing" : "\u2717 invalid",
        color: e.status === "ok" ? green : red,
      },
      { text: String(e.errors), color: e.errors > 0 ? red : undefined },
      { text: e.warnings > 0 ? String(e.warnings) : "-" },
      { text: e.status === "ok" ? (e.warnings > 0 ? e.notes : "-") : e.notes, color: e.status === "ok" ? undefined : red },
    ]);
  for (const u of report.untracked) {
    rows.push([
      { text: u.name, color: yellow },
      { text: "-", color: yellow },
      { text: "! untracked", color: yellow },
      { text: "-" },
      { text: "-" },
      { text: "not in the lockfile — hand-installed or added", color: yellow },
    ]);
  }
  printTable(["NAME", "PINNED", "STATUS", "ERRORS", "WARNINGS", "NOTES"], rows);

  const missing = report.entries.filter((e) => e.status === "missing").length;
  const invalid = report.entries.filter((e) => e.status === "invalid").length;
  const ok = report.entries.filter((e) => e.status === "ok").length;
  console.log(
    `\n${report.entries.length} locked skill(s): ${green(`${ok} ok`)}` +
      (missing > 0 ? `, ${red(`${missing} missing`)}` : `, ${missing} missing`) +
      (invalid > 0 ? `, ${red(`${invalid} invalid`)}` : `, ${invalid} invalid`) +
      (report.untracked.length > 0 ? `; ${yellow(`${report.untracked.length} untracked (warning)`)}` : ""),
  );
  if (!report.ok) {
    console.error(red(`verify failed: run '${BIN} install --frozen' to restore pinned skills.`));
    process.exitCode = 1;
  }
}

// ----------------------------------------------------------------- args ----

interface ParsedArgs {
  command?: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

function parseArgv(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      flags.help = true;
    } else if (a === "--version" || a === "-v") {
      flags.version = true;
    } else if (a === "--force") {
      flags.force = true;
    } else if (a === "--frozen") {
      flags.frozen = true;
    } else if (a === "--path" || a === "--subdir") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`missing value for ${a}`);
      }
      flags[a === "--path" ? "path" : "subdir"] = value;
    } else if (a.startsWith("--")) {
      throw new UsageError(`unknown option: ${a}`);
    } else if (command === undefined) {
      command = a;
    } else {
      positionals.push(a);
    }
  }
  return { command, positionals, flags };
}

// ----------------------------------------------------------------- main ----

async function main(): Promise<void> {
  const { command, positionals, flags } = parseArgv(process.argv.slice(2));

  if (flags.version === true) {
    console.log(VERSION);
    return;
  }
  if (flags.help === true) {
    printHelp();
    return;
  }

  switch (command) {
    case undefined:
      printHelp();
      return;
    case "init": {
      if (positionals.length !== 1) throw new UsageError(`usage: ${BIN} init <name>`);
      await cmdInit(positionals[0], flagString(flags, "path"));
      return;
    }
    case "validate": {
      if (positionals.length > 1) throw new UsageError(`usage: ${BIN} validate [path]`);
      await cmdValidate(positionals[0], flagString(flags, "path"));
      return;
    }
    case "list": {
      if (positionals.length > 1) throw new UsageError(`usage: ${BIN} list [path]`);
      await cmdList(positionals[0], flagString(flags, "path"));
      return;
    }
    case "install": {
      if (positionals.length > 1) {
        throw new UsageError(`usage: ${BIN} install <git-url> [--subdir <path>] [--force] | install [<name>] --frozen`);
      }
      await cmdInstall(positionals[0], flags);
      return;
    }
    case "update": {
      await cmdUpdate(positionals, flags);
      return;
    }
    case "verify": {
      if (positionals.length > 0) throw new UsageError(`usage: ${BIN} verify [--path <dir>]`);
      await cmdVerify(flags);
      return;
    }
    case "uninstall": {
      if (positionals.length !== 1) throw new UsageError(`usage: ${BIN} uninstall <name>`);
      await cmdUninstall(positionals[0], flags);
      return;
    }
    default: {
      console.error(red(`unknown command: ${command}`));
      console.error("");
      printHelp();
      process.exitCode = 2;
      return;
    }
  }
}

const invokedAsBin =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsBin) {
  main().catch((err: unknown) => {
    if (err instanceof UsageError) {
      console.error(red(`error: ${err.message}`));
      console.error(dim(`Run '${BIN} --help' for usage.`));
      process.exitCode = 2;
    } else {
      console.error(red(`error: ${err instanceof Error ? err.message : String(err)}`));
      process.exitCode = 1;
    }
  });
}
