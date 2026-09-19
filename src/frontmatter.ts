/**
 * Parsing and serialization for the SKILL.md frontmatter format.
 *
 * A SKILL.md file looks like:
 *
 *   ---
 *   name: my-skill
 *   description: Use when ...
 *   ---
 *
 *   Instruction body ...
 *
 * The parser is strict about fences (the file must START with a `---` line and
 * the frontmatter must be closed by a second `---` line) and forgiving about
 * line endings: CRLF (and lone CR) input is normalized to LF internally, and a
 * leading UTF-8 BOM is stripped, so files edited on Windows parse identically
 * to files written on Unix.
 */
import { YAMLParseError, parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** Error codes thrown by {@link parse}. */
export type FrontmatterErrorCode =
  | "FM_MISSING_OPENING_FENCE"
  | "FM_MISSING_CLOSING_FENCE"
  | "FM_EMPTY_FRONTMATTER"
  | "FM_INVALID_YAML"
  | "FM_NOT_MAPPING";

/** Precise, machine-readable parse failure for a SKILL.md file. */
export class FrontmatterError extends Error {
  readonly code: FrontmatterErrorCode;
  /** 1-based line number in the file, when known. */
  readonly line?: number;

  constructor(code: FrontmatterErrorCode, message: string, line?: number) {
    super(message);
    this.name = "FrontmatterError";
    this.code = code;
    this.line = line;
  }
}

export interface FrontmatterFences {
  /** 1-based line number of the opening `---` fence (always 1 for valid files). */
  start: number;
  /** 1-based line number of the closing `---` fence. */
  end: number;
}

export interface ParsedSkillMarkdown {
  /** Parsed YAML frontmatter as a plain object. */
  data: Record<string, unknown>;
  /** Everything after the closing fence. Line endings normalized to LF. */
  body: string;
  /** Raw frontmatter text between the fences (LF-normalized, fences excluded). */
  raw: string;
  /** 1-based fence line numbers. */
  fences: FrontmatterFences;
}

const FENCE = "---";

export function parse(text: string): ParsedSkillMarkdown {
  let src = text;
  if (src.startsWith("﻿")) {
    // Tolerate a UTF-8 BOM (common when files are edited with Windows Notepad).
    src = src.slice(1);
  }
  // Normalize CRLF (and lone CR) to LF so fence detection and YAML line
  // numbers behave identically regardless of the file's line endings.
  src = src.replace(/\r\n?/g, "\n");
  const lines = src.split("\n");

  if (lines[0].trim() !== FENCE) {
    throw new FrontmatterError(
      "FM_MISSING_OPENING_FENCE",
      `SKILL.md must start with a '${FENCE}' fence line; found ${JSON.stringify(lines[0].slice(0, 40))}`,
    );
  }

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === FENCE) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    throw new FrontmatterError(
      "FM_MISSING_CLOSING_FENCE",
      `frontmatter is never closed: missing a second '${FENCE}' fence line`,
    );
  }

  const raw = lines.slice(1, endIdx).join("\n");
  if (raw.trim().length === 0) {
    throw new FrontmatterError(
      "FM_EMPTY_FRONTMATTER",
      "frontmatter must contain at least a 'name' field; it must not be empty",
    );
  }

  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    if (err instanceof YAMLParseError) {
      const relLine = err.linePos?.[0]?.line;
      // raw line N corresponds to file line N + 1 (the opening fence is line 1).
      const fileLine = relLine === undefined ? undefined : 1 + relLine;
      const reason = err.message.split("\n")[0].trim() || "invalid YAML";
      throw new FrontmatterError(
        "FM_INVALID_YAML",
        `invalid YAML in frontmatter${fileLine !== undefined ? ` (file line ${fileLine})` : ""}: ${reason}`,
        fileLine,
      );
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new FrontmatterError("FM_INVALID_YAML", `invalid YAML in frontmatter: ${reason}`);
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    const kind = Array.isArray(data) ? "an array" : data === null ? "null" : `a ${typeof data}`;
    throw new FrontmatterError(
      "FM_NOT_MAPPING",
      `frontmatter must be a YAML mapping (key: value pairs), but it parsed to ${kind}`,
    );
  }

  const body = lines.slice(endIdx + 1).join("\n");
  return {
    data: data as Record<string, unknown>,
    body,
    raw,
    fences: { start: 1, end: endIdx + 1 },
  };
}

/**
 * Serialize frontmatter data plus a body back into canonical SKILL.md text
 * (LF line endings, YAML block mapping, one blank line between the closing
 * fence and the body, trailing newline).
 */
export function serialize(data: Record<string, unknown>, body: string): string {
  let yamlText = stringifyYaml(data);
  if (!yamlText.endsWith("\n")) {
    yamlText += "\n";
  }
  const normalizedBody = body.replace(/\r\n?/g, "\n");
  const bodyPart =
    normalizedBody.length === 0
      ? ""
      : normalizedBody.endsWith("\n")
        ? normalizedBody
        : normalizedBody + "\n";
  return `---\n${yamlText}---\n${bodyPart.length > 0 ? "\n" + bodyPart : ""}`;
}
