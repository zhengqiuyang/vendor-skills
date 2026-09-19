/**
 * The `verify` command: a CI gate over the vendored skills tree.
 *
 * Checks that (a) every lockfile entry has its skill directory under the
 * skills root, (b) every locked skill passes validation with zero
 * error-level diagnostics, and (c) every skill directory on disk that the
 * lockfile does not know about is reported as a warning ("untracked").
 * Warnings never fail the gate; a missing directory or an invalid skill does.
 */
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { lockPath, readLock } from "./lock.js";
import { findSkillDirs } from "./skills-dir.js";
import { countSummary, validateSkillDir } from "./validate.js";

export type VerifyStatus = "ok" | "missing" | "invalid";

export interface VerifyEntry {
  name: string;
  /** The commit pinned in the lockfile. */
  pinnedCommit: string;
  status: VerifyStatus;
  errors: number;
  warnings: number;
  /** Diagnostic codes (invalid skills) or a short explanation. */
  notes: string;
}

export interface VerifyReport {
  entries: VerifyEntry[];
  /** Skill directories on disk with no lockfile entry (warnings only). */
  untracked: { name: string; path: string }[];
  /** True when every lock entry is present and valid. */
  ok: boolean;
}

export async function verifySkills(root: string): Promise<VerifyReport> {
  if (!existsSync(lockPath(root))) {
    throw new Error(
      `no lockfile at ${lockPath(root)} — nothing to verify. Run 'vendor-skills install <git-url>' first.`,
    );
  }
  const lock = await readLock(root);

  const entries: VerifyEntry[] = [];
  const lockedDirs = new Set<string>();
  for (const entry of lock.skills) {
    const dir = resolve(join(root, entry.name));
    lockedDirs.add(dir);
    if (!existsSync(join(dir, "SKILL.md"))) {
      entries.push({
        name: entry.name,
        pinnedCommit: entry.source.commit,
        status: "missing",
        errors: 0,
        warnings: 0,
        notes: "directory not found under the skills root",
      });
      continue;
    }
    const validation = await validateSkillDir(dir);
    const { errors, warnings } = countSummary(validation.diagnostics);
    entries.push({
      name: entry.name,
      pinnedCommit: entry.source.commit,
      status: errors > 0 ? "invalid" : "ok",
      errors,
      warnings,
      notes: validation.diagnostics.map((d) => d.code).join(", ") || "-",
    });
  }

  const untracked = (await findSkillDirs(root))
    .filter((dir) => !lockedDirs.has(resolve(dir)))
    .map((dir) => ({ name: basename(dir), path: dir }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { entries, untracked, ok: entries.every((e) => e.status === "ok") };
}
