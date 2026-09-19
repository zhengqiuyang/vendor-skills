/**
 * Skill validation rules for SKILL.md files.
 *
 * Every rule produces a diagnostic with a stable code (e.g. SKILL_NAME_MISMATCH)
 * and a level: "error" (makes the skill invalid) or "warning" (advisory only).
 * A skill is valid when it has zero error-level diagnostics.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { FrontmatterError, parse } from "./frontmatter.js";
import type { FrontmatterFences } from "./frontmatter.js";

export type DiagnosticLevel = "error" | "warning";

export interface Diagnostic {
  level: DiagnosticLevel;
  /** Stable machine-readable identifier, e.g. SKILL_NAME_MISMATCH. */
  code: string;
  /** Human-readable explanation. */
  message: string;
  /** 1-based line number in SKILL.md, when known. */
  line?: number;
}

export interface ValidationResult {
  /** True when there are no error-level diagnostics. */
  valid: boolean;
  diagnostics: Diagnostic[];
  /** frontmatter name, when the frontmatter parsed and it is a string. */
  name?: string;
  /** frontmatter description, when present and a string. */
  description?: string;
}

export interface ValidateOptions {
  /**
   * Skip the "name must equal the directory name" rule. Used when validating a
   * skill inside a freshly cloned temp directory whose basename is random; the
   * rule is re-satisfied by construction once the skill is copied to
   * `<dest>/<name>`.
   */
  ignoreDirNameMismatch?: boolean;
}

export const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const NAME_MAX_LENGTH = 64;
export const DESCRIPTION_MAX_LENGTH = 1024;
export const DESCRIPTION_MIN_RECOMMENDED_LENGTH = 20;
export const BODY_MAX_WORDS = 5000;

const KNOWN_KEYS = new Set(["name", "description", "allowed-tools", "license", "metadata"]);

// Heuristic words that suggest the description tells an agent *when* to load
// the skill - the single most important property for skill discovery.
const WHEN_TO_USE_HINTS = [
  "when",
  "whenever",
  "use ",
  "used ",
  "using",
  "for ",
  "if ",
  "while ",
  "during",
  "trigger",
];

export function countSummary(diagnostics: readonly Diagnostic[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const d of diagnostics) {
    if (d.level === "error") errors += 1;
    else warnings += 1;
  }
  return { errors, warnings };
}

function hintsAtWhenToUse(description: string): boolean {
  const lower = description.toLowerCase();
  return WHEN_TO_USE_HINTS.some((hint) => lower.includes(hint));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when a markdown link target should be checked as a file on disk. */
function isRelativeFileTarget(target: string): boolean {
  if (target.length === 0) return false;
  if (target.startsWith("#")) return false; // in-page anchor
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false; // http:, https:, mailto:, C:\...
  if (target.startsWith("/") || target.startsWith("\\")) return false; // absolute paths
  return true;
}

/**
 * Find relative file references in the body that do not exist on disk.
 *
 * Two shapes are recognized:
 *  - markdown links/images: [label](./references/spec.md)
 *  - backtick paths like `scripts/helper.py` - these are only reported when the
 *    containing directory exists (e.g. scripts/ is there but the file is not),
 *    which keeps illustrative paths in prose from producing noise.
 */
function checkBodyRefs(dir: string, body: string, fences: FrontmatterFences): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  const bodyLineOf = (matchIndex: number): number =>
    fences.end + 1 + body.slice(0, matchIndex).split("\n").length - 1;

  const MD_LINK = /\[[^\]]*\]\(\s*<?([^)\s<>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  for (const match of body.matchAll(MD_LINK)) {
    let target = match[1];
    target = target.split("#")[0];
    if (!isRelativeFileTarget(target) || seen.has(target)) continue;
    if (existsSync(resolve(dir, target))) {
      seen.add(target);
      continue;
    }
    seen.add(target);
    diagnostics.push({
      level: "warning",
      code: "SKILL_MISSING_REF",
      message: `body links to "${target}", which does not exist in the skill directory`,
      line: bodyLineOf(match.index ?? 0),
    });
  }

  const BACKTICK = /`([^`\n]+)`/g;
  for (const match of body.matchAll(BACKTICK)) {
    const s = match[1];
    if (/\s/.test(s)) continue; // prose, not a path
    if (!/[\\/]/.test(s)) continue; // no separator -> not a path
    if (/[<>$*]/.test(s)) continue; // placeholders like <path> or globs
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) continue; // urls and drive letters
    if (s.startsWith("/") || s.startsWith("\\")) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    const abs = resolve(dir, s);
    if (existsSync(abs)) continue;
    if (existsSync(dirname(abs))) {
      diagnostics.push({
        level: "warning",
        code: "SKILL_MISSING_REF",
        message: `body references "${s}", which does not exist in the skill directory`,
        line: bodyLineOf(match.index ?? 0),
      });
    }
  }
  return diagnostics;
}

export async function validateSkillDir(dir: string, options: ValidateOptions = {}): Promise<ValidationResult> {
  const diagnostics: Diagnostic[] = [];
  const skillMdPath = resolve(dir, "SKILL.md");

  let text: string;
  try {
    text = await readFile(skillMdPath, "utf8");
  } catch {
    return {
      valid: false,
      diagnostics: [
        { level: "error", code: "SKILL_MD_MISSING", message: `no SKILL.md found in ${dir}` },
      ],
    };
  }

  let parsed;
  try {
    parsed = parse(text);
  } catch (err) {
    if (err instanceof FrontmatterError) {
      return {
        valid: false,
        diagnostics: [{ level: "error", code: err.code, message: err.message, line: err.line }],
      };
    }
    throw err;
  }

  const { data, body, raw, fences } = parsed;
  const rawLines = raw.split("\n");
  const lineOfKey = (key: string): number | undefined => {
    const re = new RegExp(`^\\s*["']?${escapeRegExp(key)}["']?\\s*:`);
    const idx = rawLines.findIndex((l) => re.test(l));
    return idx === -1 ? undefined : fences.start + 1 + idx;
  };

  // --- name ---
  const name = data["name"];
  const nameLine = lineOfKey("name");
  if (name === undefined || name === null) {
    diagnostics.push({
      level: "error",
      code: "SKILL_NAME_MISSING",
      message: "frontmatter must contain a 'name' field",
      line: nameLine,
    });
  } else if (typeof name !== "string") {
    diagnostics.push({
      level: "error",
      code: "SKILL_NAME_INVALID",
      message: `'name' must be a string (got ${Array.isArray(name) ? "an array" : typeof name})`,
      line: nameLine,
    });
  } else {
    if (!NAME_PATTERN.test(name)) {
      diagnostics.push({
        level: "error",
        code: "SKILL_NAME_INVALID",
        message: `'name' "${name}" must be lowercase kebab-case matching ${NAME_PATTERN.source}`,
        line: nameLine,
      });
    }
    if (name.length > NAME_MAX_LENGTH) {
      diagnostics.push({
        level: "error",
        code: "SKILL_NAME_TOO_LONG",
        message: `'name' is ${name.length} characters; the maximum is ${NAME_MAX_LENGTH}`,
        line: nameLine,
      });
    }
    if (!options.ignoreDirNameMismatch && name !== basename(resolve(dir))) {
      diagnostics.push({
        level: "error",
        code: "SKILL_NAME_MISMATCH",
        message: `frontmatter 'name' "${name}" must equal the skill directory name "${basename(resolve(dir))}"`,
        line: nameLine,
      });
    }
  }

  // --- description ---
  const description = data["description"];
  const descriptionLine = lineOfKey("description");
  if (description === undefined || description === null) {
    diagnostics.push({
      level: "error",
      code: "SKILL_DESCRIPTION_MISSING",
      message: "frontmatter must contain a 'description' field",
      line: descriptionLine,
    });
  } else if (typeof description !== "string") {
    diagnostics.push({
      level: "error",
      code: "SKILL_DESCRIPTION_INVALID",
      message: `'description' must be a string (got ${Array.isArray(description) ? "an array" : typeof description})`,
      line: descriptionLine,
    });
  } else {
    const trimmed = description.trim();
    if (trimmed.length === 0) {
      diagnostics.push({
        level: "error",
        code: "SKILL_DESCRIPTION_MISSING",
        message: "frontmatter must contain a 'description' field (it is empty)",
        line: descriptionLine,
      });
    } else {
      if (trimmed.length > DESCRIPTION_MAX_LENGTH) {
        diagnostics.push({
          level: "error",
          code: "SKILL_DESCRIPTION_TOO_LONG",
          message: `'description' is ${trimmed.length} characters; the maximum is ${DESCRIPTION_MAX_LENGTH}`,
          line: descriptionLine,
        });
      }
      if (trimmed.length < DESCRIPTION_MIN_RECOMMENDED_LENGTH) {
        diagnostics.push({
          level: "warning",
          code: "SKILL_DESCRIPTION_SHORT",
          message: `'description' is only ${trimmed.length} characters; use at least ${DESCRIPTION_MIN_RECOMMENDED_LENGTH} so agents can decide when to load the skill`,
          line: descriptionLine,
        });
      }
      if (!hintsAtWhenToUse(trimmed)) {
        diagnostics.push({
          level: "warning",
          code: "SKILL_DESCRIPTION_NO_TRIGGER",
          message:
            "'description' does not hint at when to use the skill; mention trigger conditions (e.g. \"Use when the user asks to ...\")",
          line: descriptionLine,
        });
      }
    }
  }

  // --- optional keys ---
  const unknownKeys = Object.keys(data).filter((k) => !KNOWN_KEYS.has(k));
  if (unknownKeys.length > 0) {
    diagnostics.push({
      level: "warning",
      code: "SKILL_UNKNOWN_KEYS",
      message: `unknown frontmatter key(s): ${unknownKeys.join(", ")} (known keys: ${[...KNOWN_KEYS].join(", ")})`,
      line: lineOfKey(unknownKeys[0]),
    });
  }
  const metadata = data["metadata"];
  if (
    "metadata" in data &&
    (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))
  ) {
    diagnostics.push({
      level: "warning",
      code: "SKILL_METADATA_NOT_OBJECT",
      message: `'metadata' should be a YAML mapping (got ${Array.isArray(metadata) ? "an array" : typeof metadata})`,
      line: lineOfKey("metadata"),
    });
  }

  // --- body ---
  if (body.trim().length === 0) {
    diagnostics.push({
      level: "error",
      code: "SKILL_BODY_EMPTY",
      message: "body after the closing '---' fence must not be empty",
      line: fences.end + 1,
    });
  } else {
    const words = body.trim().split(/\s+/).length;
    if (words > BODY_MAX_WORDS) {
      diagnostics.push({
        level: "warning",
        code: "SKILL_BODY_TOO_LONG",
        message: `body is ${words} words (recommended maximum ${BODY_MAX_WORDS}); consider splitting into reference files`,
      });
    }
    diagnostics.push(...checkBodyRefs(resolve(dir), body, fences));
  }

  const result: ValidationResult = {
    valid: diagnostics.every((d) => d.level !== "error"),
    diagnostics,
  };
  if (typeof name === "string") result.name = name;
  if (typeof description === "string") result.description = description.trim();
  return result;
}
