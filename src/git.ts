/**
 * Install, restore, update, and uninstall skills from git repositories.
 *
 * Flows implemented here:
 *  - installSkill: shallow clone (blob-filtered) of the default branch, locate
 *    the skill (explicit --subdir or auto-detection), validate it (invalid
 *    skills are refused), copy it into <dest>/<name> without .git, pin the
 *    commit in the lockfile.
 *  - installSkillFrozen: hermetic restore driven by the lockfile alone. Full
 *    history clone (NO --depth 1: a shallow clone of the default branch may
 *    not contain an old pinned SHA), then `git checkout <sha>` of the pinned
 *    commit. The lockfile is never written in frozen mode.
 *  - updateSkills: re-clone at the latest default-branch HEAD, re-validate,
 *    replace the skill directory, and re-pin the lockfile entry.
 *
 * All git invocations go through child_process.execFile with captured stderr
 * and friendly error messages.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { promisify } from "node:util";
import { UsageError } from "./errors.js";
import { lockPath, readLock, writeLock } from "./lock.js";
import type { LockEntry, LockFile } from "./lock.js";
import { validateSkillDir } from "./validate.js";
import type { Diagnostic } from "./validate.js";

const execFileAsync = promisify(execFile);

const IGNORED_DIRS = new Set(["node_modules", ".git"]);

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0", // never hang waiting for credentials
  };
}

async function git(args: string[], opts: { cwd?: string } = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: opts.cwd,
      env: gitEnv(),
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string | Buffer; message?: string };
    const raw = e.stderr ? e.stderr.toString() : e.message ?? "unknown git error";
    const detail = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 4)
      .join(" | ");
    let hint = "";
    if (/not found|does not (appear|exist)|Authentication failed|Permission denied|could not read/i.test(detail)) {
      hint = " Check the repository URL, your credentials, and network access.";
    }
    throw new Error(`git ${args[0]} failed: ${detail || "no output"}.${hint}`);
  }
}

function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return diagnostics
    .map((d) => `    [${d.level}] ${d.code}: ${d.message}${d.line !== undefined ? ` (line ${d.line})` : ""}`)
    .join("\n");
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name)).map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

/** Walk the repo root and two levels below it, collecting dirs that contain a SKILL.md. */
async function findSkillDirCandidates(repoDir: string): Promise<string[]> {
  const candidates: string[] = [];
  const consider = (dir: string) => {
    if (existsSync(join(dir, "SKILL.md"))) candidates.push(dir);
  };
  consider(repoDir);
  for (const level1 of await listDirs(repoDir)) {
    consider(level1);
    for (const level2 of await listDirs(level1)) {
      consider(level2);
    }
  }
  return candidates;
}

/** Locate the skill directory inside a freshly cloned repo and validate it. */
async function locateAndValidate(
  tmp: string,
  sourceLabel: string,
  subdir?: string,
): Promise<{ skillDir: string; name: string; warnings: Diagnostic[] }> {
  let skillDir: string;
  if (subdir !== undefined && subdir !== "") {
    skillDir = join(tmp, subdir);
    if (!existsSync(join(skillDir, "SKILL.md"))) {
      throw new Error(`--subdir "${subdir}" does not contain a SKILL.md (looked for ${join(skillDir, "SKILL.md")}).`);
    }
  } else {
    const candidates = await findSkillDirCandidates(tmp);
    if (candidates.length === 0) {
      throw new Error(
        `no SKILL.md found anywhere in ${sourceLabel} (checked the repository root and two levels below). Is this a skill repository?`,
      );
    }
    if (candidates.length > 1) {
      const list = candidates.map((c) => `    - ${relative(tmp, c) || "."}`).join("\n");
      throw new Error(
        `multiple skills found in this repository:\n${list}\n  Re-run with --subdir <path-from-repo-root> to pick one.`,
      );
    }
    skillDir = candidates[0];
  }

  // A skill found at the repo root lives in a temp dir with a random name,
  // so the name == directory-name rule is checked against the install
  // destination instead (which is <dest>/<name> by construction).
  const validation = await validateSkillDir(skillDir, { ignoreDirNameMismatch: skillDir === tmp });
  if (!validation.valid) {
    throw new Error(
      `refusing to install invalid skill from ${sourceLabel}:\n${formatDiagnostics(
        validation.diagnostics.filter((d) => d.level === "error"),
      )}`,
    );
  }
  if (validation.name === undefined) {
    throw new Error(`skill at ${sourceLabel} has no 'name' in its frontmatter.`);
  }
  return {
    skillDir,
    name: validation.name,
    warnings: validation.diagnostics.filter((d) => d.level === "warning"),
  };
}

/** Copy a validated skill directory into `<dest>/<name>` (`.git` excluded). */
async function copyIn(skillDir: string, dest: string, name: string, force: boolean): Promise<string> {
  const destDir = join(dest, name);
  if (existsSync(destDir)) {
    if (!force) {
      throw new Error(`skill "${name}" is already installed at ${destDir}. Re-run with --force to replace it.`);
    }
    await rm(destDir, { recursive: true, force: true });
  }
  await cp(skillDir, destDir, {
    recursive: true,
    filter: (src) => basename(src) !== ".git",
  });
  return destDir;
}

async function makeTemp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

// --------------------------------------------------------------- install ---

export interface InstallOptions {
  /** Skills root directory; the skill lands in `<dest>/<name>`. */
  dest: string;
  /** Explicit path inside the repository that contains the skill. */
  subdir?: string;
  /** Replace an already-installed skill instead of refusing. */
  force?: boolean;
}

export interface InstallResult {
  name: string;
  dir: string;
  commit: string;
  subdir?: string;
  warnings: Diagnostic[];
}

/** Normal install: shallow-clone the default branch, validate, copy, pin. */
export async function installSkill(gitUrl: string, options: InstallOptions): Promise<InstallResult> {
  const tmp = await makeTemp("vendor-skills-clone-");
  try {
    await git(["clone", "--depth", "1", "--filter=blob:none", gitUrl, tmp]);
    const located = await locateAndValidate(tmp, gitUrl, options.subdir);
    const destDir = await copyIn(located.skillDir, options.dest, located.name, options.force === true);

    const commit = (await git(["-C", tmp, "rev-parse", "HEAD"])).trim();

    const lock = await readLock(options.dest);
    lock.skills = lock.skills.filter((s) => s.name !== located.name);
    lock.skills.push({
      name: located.name,
      source: { git: gitUrl, ...(options.subdir ? { subdir: options.subdir } : {}), commit },
      installedAt: new Date().toISOString(),
    });
    await writeLock(options.dest, lock);

    return {
      name: located.name,
      dir: destDir,
      commit,
      ...(options.subdir ? { subdir: options.subdir } : {}),
      warnings: located.warnings,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------- frozen ---

export interface FrozenInstallOptions {
  /** Skills root directory; the skill lands in `<dest>/<name>`. */
  dest: string;
}

/**
 * Hermetic install driven by the lockfile alone (`install --frozen`).
 *
 * `ref` selects what to restore: a git URL (matched against lock entries'
 * `source.git`), a skill name, or undefined for "every lock entry" — the
 * `npm ci` shape used in CI. The pinned commit is checked out of a full
 * history clone (never a shallow one: the default branch may no longer
 * contain an old SHA). The lockfile is never written.
 */
export async function installSkillFrozen(ref: string | undefined, options: FrozenInstallOptions): Promise<InstallResult[]> {
  const dest = options.dest;
  if (!existsSync(lockPath(dest))) {
    throw new UsageError(
      `--frozen requires a lockfile at ${lockPath(dest)}, but none exists. ` +
        `Run 'vendor-skills install <git-url>' (without --frozen) first to create it.`,
    );
  }
  const lock = await readLock(dest);
  if (lock.skills.length === 0) {
    throw new UsageError(`--frozen: the lockfile at ${lockPath(dest)} has no entries. Install a skill normally first.`);
  }
  let entries: LockEntry[];
  if (ref === undefined) {
    entries = lock.skills;
  } else {
    const entry = lock.skills.find((s) => s.source.git === ref) ?? lock.skills.find((s) => s.name === ref);
    if (!entry) {
      const names = lock.skills.map((s) => s.name).join(", ");
      throw new UsageError(
        `--frozen: "${ref}" is not pinned in the lockfile (locked skills: ${names}). ` +
          `--frozen restores pinned versions only; run a normal 'vendor-skills install <git-url>' first.`,
      );
    }
    entries = [entry];
  }

  const results: InstallResult[] = [];
  for (const entry of entries) {
    const tmp = await makeTemp("vendor-skills-frozen-");
    try {
      // Full history (blob-filtered): a shallow clone of the default branch
      // may not contain the pinned commit.
      await git(["clone", "--filter=blob:none", entry.source.git, tmp]);
      try {
        await git(["-C", tmp, "checkout", "--quiet", entry.source.commit]);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `the pinned commit ${shortSha(entry.source.commit)} for "${entry.name}" is unreachable from ` +
            `${entry.source.git} (history rewritten, or the commit was garbage-collected?). ${reason} ` +
            `Re-pin with 'vendor-skills install ${entry.source.git} --force' or bump with 'vendor-skills update ${entry.name}'.`,
        );
      }
      const commit = (await git(["-C", tmp, "rev-parse", "HEAD"])).trim();
      if (!commit.startsWith(entry.source.commit) && !entry.source.commit.startsWith(commit)) {
        throw new Error(
          `checked out ${shortSha(commit)} but the lockfile pins "${entry.name}" to ${shortSha(entry.source.commit)}; refusing to continue.`,
        );
      }

      const located = await locateAndValidate(tmp, entry.source.git, entry.source.subdir);
      if (located.name !== entry.name) {
        throw new Error(
          `the pinned commit for "${entry.name}" contains a skill named "${located.name}" — ` +
            `the lockfile and the repository disagree. Re-install normally to re-pin.`,
        );
      }
      // Frozen restores exactly the pinned commit: an existing directory is
      // replaced (this is restore-to-pin, not a mutating install).
      const destDir = await copyIn(located.skillDir, dest, located.name, true);

      results.push({
        name: located.name,
        dir: destDir,
        commit,
        ...(entry.source.subdir ? { subdir: entry.source.subdir } : {}),
        warnings: located.warnings,
      });
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return results;
}

// ---------------------------------------------------------------- update ---

export interface SkillUpdate {
  name: string;
  outcome: "updated" | "up-to-date" | "skipped" | "failed";
  oldCommit?: string;
  newCommit?: string;
  /** Explanation for "skipped" and "failed" outcomes. */
  message?: string;
}

export interface UpdateOptions {
  /** Skills root directory (also where the lockfile lives). */
  dest: string;
}

/**
 * Re-clone the latest default branch for each named skill (all lock entries
 * when no names are given), validate, replace the skill directory, and
 * re-pin the lockfile entry. Skills named on the command line that have no
 * lock entry are reported as "skipped" (hand-installed), not fatal.
 */
export async function updateSkills(names: string[] | undefined, options: UpdateOptions): Promise<SkillUpdate[]> {
  const dest = options.dest;
  const lock = await readLock(dest);
  if (lock.skills.length === 0) {
    throw new Error(`no skills to update: ${lockPath(dest)} is empty or missing. Install a skill first.`);
  }

  const results: SkillUpdate[] = [];
  const targets: LockEntry[] = [];
  if (names === undefined || names.length === 0) {
    targets.push(...lock.skills);
  } else {
    for (const name of names) {
      const entry = lock.skills.find((s) => s.name === name);
      if (!entry) {
        results.push({
          name,
          outcome: "skipped",
          message: `not tracked by vendor-skills (no entry in ${lockPath(dest)}) — hand-installed? skipped.`,
        });
      } else {
        targets.push(entry);
      }
    }
  }

  let updatedLock: LockFile | undefined;
  for (const entry of targets) {
    const tmp = await makeTemp("vendor-skills-update-");
    try {
      await git(["clone", "--depth", "1", "--filter=blob:none", entry.source.git, tmp]);
      const newCommit = (await git(["-C", tmp, "rev-parse", "HEAD"])).trim();
      if (newCommit === entry.source.commit) {
        results.push({ name: entry.name, outcome: "up-to-date", oldCommit: entry.source.commit, newCommit });
        continue;
      }
      const located = await locateAndValidate(tmp, entry.source.git, entry.source.subdir);
      if (located.name !== entry.name) {
        throw new Error(
          `the latest commit contains a skill named "${located.name}", but the lockfile pins "${entry.name}" — refusing to switch identities under an update.`,
        );
      }
      await copyIn(located.skillDir, dest, located.name, true); // update always replaces
      const next: LockFile = updatedLock ?? { version: 1, skills: lock.skills.map((s) => ({ ...s })) };
      const idx = next.skills.findIndex((s) => s.name === entry.name);
      next.skills[idx] = {
        name: entry.name,
        source: { ...entry.source, commit: newCommit },
        installedAt: new Date().toISOString(),
      };
      updatedLock = next;
      results.push({ name: entry.name, outcome: "updated", oldCommit: entry.source.commit, newCommit });
    } catch (err) {
      results.push({
        name: entry.name,
        outcome: "failed",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  if (updatedLock !== undefined) {
    await writeLock(dest, updatedLock);
  }
  return results;
}

// -------------------------------------------------------------- uninstall ---

export async function uninstallSkill(name: string, options: { dest: string }): Promise<void> {
  const lock = await readLock(options.dest);
  const entry = lock.skills.find((s) => s.name === name);
  if (!entry) {
    const dir = join(options.dest, name);
    const extra = existsSync(dir)
      ? " The directory exists on disk but was not installed by vendor-skills; delete it manually if you are sure."
      : "";
    throw new Error(`"${name}" is not tracked by vendor-skills (no entry in ${lockPath(options.dest)}).${extra}`);
  }
  const dir = join(options.dest, name);
  if (!existsSync(dir)) {
    throw new Error(
      `the lockfile has an entry for "${name}", but ${dir} is missing; reinstall it or remove the stale entry from the lockfile.`,
    );
  }
  await rm(dir, { recursive: true, force: true });
  lock.skills = lock.skills.filter((s) => s.name !== name);
  await writeLock(options.dest, lock);
}
