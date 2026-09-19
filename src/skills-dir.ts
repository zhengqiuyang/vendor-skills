/**
 * Skills root resolution and indexing.
 *
 * The skills root is where `vendor-skills list` / `install` / `uninstall` /
 * `update` / `verify` operate. The default is `.agents/skills` — the
 * multi-harness convergence directory: `gh skill` documents it as the shared
 * location read by GitHub Copilot, Cursor, Codex, Gemini CLI and friends, and
 * OpenCode reads it too. Vendoring skills there means one committed copy (plus
 * the lockfile) serves every harness at once. An explicit `--path` beats the
 * default, and the directory is created on demand so a fresh project needs no
 * manual setup.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { countSummary, validateSkillDir } from "./validate.js";

/** How many directory levels below the root `scan` descends looking for SKILL.md. */
export const MAX_SCAN_DEPTH = 3;

/** Default skills root: the multi-harness convergence directory. */
export const DEFAULT_SKILLS_ROOT = join(".agents", "skills");

const IGNORED_DIRS = new Set(["node_modules", ".git"]);

export interface SkillIndexEntry {
  /** frontmatter name, or the directory name when frontmatter is unparseable. */
  name: string;
  /** Absolute path of the skill directory (the parent of SKILL.md). */
  path: string;
  /** frontmatter description, when available. */
  description: string;
  valid: boolean;
  errorCount: number;
  warningCount: number;
}

/**
 * Resolve the skills root: explicit path wins, default is `.agents/skills`;
 * create on demand.
 */
export async function resolveSkillsRoot(explicit?: string): Promise<string> {
  const root = resolve(explicit ?? DEFAULT_SKILLS_ROOT);
  await mkdir(root, { recursive: true });
  return root;
}

/**
 * Find skill directories under `root` (including root itself), up to
 * `maxDepth` levels of nesting, skipping node_modules and .git.
 */
export async function findSkillDirs(root: string, maxDepth: number = MAX_SCAN_DEPTH): Promise<string[]> {
  const dirs: string[] = [];
  if (existsSync(join(root, "SKILL.md"))) {
    dirs.push(resolve(root));
  }
  async function walk(dir: string, depth: number): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue;
      const child = join(dir, entry.name);
      if (existsSync(join(child, "SKILL.md"))) {
        dirs.push(child);
      }
      if (depth < maxDepth) {
        await walk(child, depth + 1);
      }
    }
  }
  await walk(resolve(root), 1);
  return dirs;
}

/** Build an index of all skills under `root`, sorted by name. */
export async function scanSkills(root: string): Promise<SkillIndexEntry[]> {
  const dirs = await findSkillDirs(root);
  const entries: SkillIndexEntry[] = [];
  for (const dir of dirs) {
    const result = await validateSkillDir(dir);
    const { errors, warnings } = countSummary(result.diagnostics);
    entries.push({
      name: result.name ?? basename(dir),
      path: dir,
      description: result.description ?? "",
      valid: result.valid,
      errorCount: errors,
      warningCount: warnings,
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}
