# vendor-skills

[![CI](https://github.com/zhengqiuyang/vendor-skills/actions/workflows/ci.yml/badge.svg)](https://github.com/zhengqiuyang/vendor-skills/actions/workflows/ci.yml)

**The vendoring tool for Agent Skills.**

pinned · validated · reproducible · offline

> **Use `npx skills` to discover. Use vendor-skills to lock.**

vendor-skills installs [Agent Skills](#the-skillmd-format-as-enforced-by-vendor-skills)
— the directory-plus-`SKILL.md` format open-sourced by Anthropic in late 2025 —
from **any git remote** into the **`.agents/skills/`** convergence directory,
behind a **validation gate**, and records every skill in a **committed
lockfile** pinned to an exact commit.

```console
$ vendor-skills install https://github.com/example/agent-skills --subdir pdf-helper
Installed pdf-helper @ 3f9c2ab1d0 -> .agents/skills/pdf-helper
Lockfile updated: .agents/skills/vendor-skills.lock

$ vendor-skills install --frozen
Restored pdf-helper @ 3f9c2ab1d0 (pinned) -> .agents/skills/pdf-helper
Lockfile left untouched (--frozen): .agents/skills/vendor-skills.lock
```

## Why

Skills discovery got solved in 2026: Vercel's `npx skills` and skills.sh,
GitHub's `gh skill`, and Microsoft's Agent Package Manager own search-and-
install, and they are great at it. Use them to find skills.

None of them own **reproducibility**. The Vercel CLI installs floating HEADs
with no pinning and ships telemetry on by default; `gh skill` pins per install
but only talks to GitHub remotes; APM is an enterprise suite, not a lockfile.
If your product's agent behavior depends on a set of skills, "works for me,
breaks for you" is a drifted skill — and no registry fixes that.

vendor-skills is the `npm ci` / `cargo vendor` of skills: a hermetic,
lockfile-first installer for teams who vendor skills into their repository and
review skill changes in diffs. It writes to `.agents/skills/` — the
convergence directory `gh skill` documents as shared across Copilot, Cursor,
Codex, Gemini CLI and friends (OpenCode reads it too) — so one committed,
pinned copy of every skill serves all your harnesses at once. Zero telemetry,
any git remote (self-hosted GitLab/gitea included), and fully offline once the
lock and your clones suffice.

## Requirements

- Node.js >= 20
- git on `PATH`

## Install

Published package (once released):

```
npm install -g vendor-skills
```

From source:

```
git clone <this-repo> vendor-skills
cd vendor-skills
npm install
npm run build
node dist/src/cli.js --help    # or: npm link
```

## Quickstart

```
vendor-skills init my-skill               # scaffold .agents/skills/my-skill
$EDITOR .agents/skills/my-skill/SKILL.md
vendor-skills validate                    # check every skill under .agents/skills
vendor-skills list                        # index: name, validity, description
vendor-skills install https://github.com/example/agent-skills --subdir pdf-helper
vendor-skills update                      # bump every pinned skill to latest HEAD
vendor-skills verify                      # CI gate: pinned + present + valid
vendor-skills uninstall pdf-helper
```

Commit `.agents/skills/` — the vendored skills **and** the lockfile — to your
repository. That is the whole point: reviewing a skill change is reviewing a
diff, and reproducing an environment is `git clone` + one command.

`npm run demo` runs the init -> validate -> list loop on a fresh checkout.

## CI: vendored skills as a pipeline gate

```yaml
name: agent-skills
on: [push, pull_request]
jobs:
  vendor-skills:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx vendor-skills install --frozen   # exact pinned commits, lock never touched
      - run: npx vendor-skills verify              # every lock entry present + valid
```

Both commands exit nonzero on any problem — a missing directory, a skill that
no longer passes the validation gate, an unreachable pinned commit — which
gates the pipeline. Warnings (untracked skill directories) never fail the
build. This is the `npm ci && npm test` shape, for skills.

## Command reference

| Command | Description | Options |
| --- | --- | --- |
| `init <name>` | Scaffold `<skills-root>/<name>/SKILL.md` (valid template: Overview / When to use / Instructions / Files) plus a short `README.md`. Refuses names that are not lowercase kebab-case. | `--path <dir>` |
| `validate [path]` | Validate one skill directory (or a single `SKILL.md` file), or scan a root for skills. Prints a table of `name / status / error and warning counts / diagnostic codes`, then details. Exit code 1 iff any skill has an error. | `--path <dir>` as fallback target |
| `list [path]` | Scan a root (default `./.agents/skills`, created on demand) up to 3 levels deep, skipping `node_modules`/`.git`, and print an index table: name, validity, counts, description, path. | `--path <dir>` |
| `install <git-url>` | Shallow-clone (`--depth 1 --filter=blob:none`) the default branch into a temp dir, locate the skill (auto-detect at up to 2 levels, or `--subdir`), validate it (invalid skills are refused), copy to `<skills-root>/<name>` without `.git`, pin the commit in the lockfile. | `--subdir <path>`, `--force`, `--path <dir>` |
| `install [<name>] --frozen` | Hermetic restore from the lockfile alone: full-history clone (`--filter=blob:none`, never `--depth 1` — the default branch may no longer contain the pinned SHA) + `git checkout <sha>`. Requires `vendor-skills.lock` to exist and contain the entry (exit 2 otherwise). Restoring replaces an existing directory; the lockfile is never written. No name: restore every pinned skill (`npm ci` shape). | `--path <dir>` |
| `update [name ...]` | For each named skill — or every lock entry when none are named: clone the latest default-branch HEAD, validate (gate), replace the skill directory, re-pin the lock entry, print `name: <old-sha-7> → <new-sha-7>`. Named skills without a lock entry are reported and skipped (hand-installed). Mutually exclusive with `--frozen` (exit 2). | `--path <dir>` |
| `verify` | CI gate. Checks every lock entry's directory exists under the root, every locked skill validates (0 error-level diagnostics), and lists on-disk skills missing from the lock as warnings ("untracked — hand-installed or added"). Prints a table; exit 0 iff locked skills are present and valid, exit 1 otherwise. | `--path <dir>` |
| `uninstall <name>` | Remove the installed directory and its lockfile entry. Refuses when there is no lock entry (i.e. the directory was not installed by vendor-skills) or the directory is already gone. | `--path <dir>` |
| `-h` / `--help` | Help everywhere: top level and after any command. | — |

Unknown commands print the help and exit with code 2. Colors are plain ANSI
(no library) and respect `NO_COLOR`.

Exit codes: `0` success, `1` validation or runtime failure, `2` usage error.

## The three install flows

**Normal install** — `vendor-skills install <git-url> [--subdir <path>] [--force]`

1. `git clone --depth 1 --filter=blob:none <url> <tmpdir>` (fast, blob-less);
2. locate the skill: explicit `--subdir`, otherwise auto-detection walks the
   repo root and two levels below for a directory containing `SKILL.md` — if
   there are several, vendor-skills lists the candidates and asks you to pick
   one with `--subdir`;
3. **validation gate**: error-level diagnostics abort the install — a broken
   skill never lands in your tree;
4. copy to `<skills-root>/<name>` (`.git` excluded; existing installs refuse
   to be overwritten unless `--force`);
5. pin: the commit (`git rev-parse HEAD`) and source are recorded in the
   lockfile (atomic write).

**Frozen install** — `vendor-skills install --frozen [<name>|<git-url>]`

Requires `vendor-skills.lock` to exist and to contain an entry for what you
are restoring (exit 2 with a clear message otherwise). Installs **exactly**
the pinned commit: a full-history clone (`--filter=blob:none`, deliberately
not `--depth 1`, because a shallow clone of the default branch may not contain
an old SHA), then `git checkout <sha>`. If the SHA is unreachable (history
rewritten, commit garbage-collected) the error explains the way out. The
lockfile is never written in frozen mode. The validation gate still applies.

**Update** — `vendor-skills update [name ...]`

Re-clones the latest default-branch HEAD for each named locked skill (all lock
entries when none are named), validates the new version, replaces the skill
directory, re-pins the lock entry, and prints `name: <old-sha-7> → <new-sha-7>`
(`(already up to date)` when HEAD equals the pin). A failed validation keeps
the old pin and the old directory. Skills named on the command line that have
no lock entry are hand-installed: reported and skipped.

## The lockfile

`.agents/skills/vendor-skills.lock` is written atomically (temp file + rename)
and pins every skill to an exact commit. Commit it with the vendored skills —
it is the contract `--frozen` and `verify` enforce.

```json
{
  "version": 1,
  "skills": [
    {
      "name": "pdf-helper",
      "source": {
        "git": "https://github.com/example/agent-skills",
        "subdir": "pdf-helper",
        "commit": "3f9c2ab1d0e8f4a2b6c1..."
      },
      "installedAt": "2026-09-19T10:12:00.000Z"
    }
  ]
}
```

## The SKILL.md format (as enforced by vendor-skills)

A skill is a directory whose name matches its frontmatter `name`, containing a
`SKILL.md`: a file that *starts* with a `---` fence, YAML frontmatter closed
by a second `---`, then a non-empty Markdown body.

| Rule | Level on violation | Code |
| --- | --- | --- |
| File starts with a `---` fence line | error | `FM_MISSING_OPENING_FENCE` |
| A second `---` closes the frontmatter | error | `FM_MISSING_CLOSING_FENCE` |
| Frontmatter is non-empty | error | `FM_EMPTY_FRONTMATTER` |
| Frontmatter is valid YAML (errors carry the file line number) | error | `FM_INVALID_YAML` |
| Frontmatter is a YAML mapping | error | `FM_NOT_MAPPING` |
| `name` is required | error | `SKILL_NAME_MISSING` |
| `name` matches `^[a-z0-9]+(-[a-z0-9]+)*$` (lowercase kebab) | error | `SKILL_NAME_INVALID` |
| `name` is at most 64 characters | error | `SKILL_NAME_TOO_LONG` |
| `name` equals the skill directory name | error | `SKILL_NAME_MISMATCH` |
| `description` is required, 1..1024 chars | error | `SKILL_DESCRIPTION_MISSING` / `_INVALID` / `_TOO_LONG` |
| `description` is at least 20 chars | warning | `SKILL_DESCRIPTION_SHORT` |
| `description` hints at *when to use* the skill (e.g. "Use when ...") | warning | `SKILL_DESCRIPTION_NO_TRIGGER` |
| Known optional keys pass through: `allowed-tools`, `license`, `metadata` (mapping) | warning if `metadata` is not a mapping | `SKILL_METADATA_NOT_OBJECT` |
| Unknown top-level keys are listed | warning | `SKILL_UNKNOWN_KEYS` |
| Body is non-empty | error | `SKILL_BODY_EMPTY` |
| Body is at most ~5000 words | warning | `SKILL_BODY_TOO_LONG` |
| Relative files referenced by the body exist on disk (markdown links/images like `./scripts/foo.py`, and backtick paths whose sibling directory exists) | warning | `SKILL_MISSING_REF` |

A skill is **valid** when it has zero error-level diagnostics; warnings are
advisory. CRLF line endings and a UTF-8 BOM are handled gracefully, so skills
edited on Windows parse identically.

The gate runs at install time (normal, frozen, and update): a skill that fails
validation never enters — or never replaces — your vendored tree.

## Non-goals

Deliberate scope. vendor-skills is a vendoring tool, not a registry:

- **No registry, no search.** Discovery belongs to `npx skills` / skills.sh,
  `gh skill`, and APM. Vendor what you already found.
- **No telemetry.** Nothing phones home, ever.
- **No per-agent path mapping.** No installing one skill into 79
  agent-specific directories — that is the registries' game. vendor-skills
  writes one copy to `.agents/skills/`, the convergence directory the
  harnesses themselves read.
- **No `publish`.** Your git repository *is* the distribution channel.

## Project layout

```
src/frontmatter.ts   parse/serialize SKILL.md fences + YAML (CRLF-safe, precise errors)
src/validate.ts      validation rules -> diagnostics (level, code, message, line)
src/skills-dir.ts    skills-root resolution (--path > .agents/skills, created on demand) + scan index
src/git.ts           install / frozen restore / update / uninstall: clone, detect, validate, copy, lock
src/verify.ts        the verify gate: lock entries present + valid; untracked dirs warned
src/lock.ts          vendor-skills.lock read (missing-tolerant) + atomic write
src/errors.ts        UsageError (exit-2 class)
src/cli.ts           the `vendor-skills` binary: init / validate / list / install / update / verify / uninstall
example-skills/      pdf-helper (valid, realistic) and broken-skill (invalid, for tests)
test/                node:test suites: frontmatter, validate, init, install (real git fixtures)
```

Runtime dependency: `yaml` only. Dev: `typescript`, `@types/node`.

## Development

```
npm install
npm run build     # tsc -> dist/
npm test          # build + node --test dist/test/
npm run demo      # init/validate/list walkthrough on a fresh checkout
```

The install/frozen/update/verify tests build real fixture git repositories in
`os.tmpdir()` (with isolated git config: `GIT_CONFIG_NOSYSTEM`, empty global
config, per-command `-c user.email`/`-c user.name`) and install from them as
local paths.

## FAQ

**Why a lockfile?**
Reproducible agent environments. An agent's behavior depends on which skills
it loads; "works for me, breaks for you" is almost always a drifted skill.
Pinning each skill to a commit — the same trick `package-lock.json` pulls for
packages — makes a set of skills installable identically on every machine and
reviewable in diffs. `install --frozen` is to `install` what `npm ci` is to
`npm install`.

**Why git instead of a registry?**
Git is already the distribution channel skills use today, needs no
infrastructure, and gives free versioning, history, and private hosting —
including self-hosted GitLab and gitea behind your firewall. Commit pinning is
the simplest honest versioning.

**Why `.agents/skills/`?**
It is the convergence directory: `gh skill` documents `.agents/skills/` as the
shared location read by GitHub Copilot, Cursor, Codex, Gemini CLI and friends,
and OpenCode reads it too. One vendored, pinned copy of each skill serves
every harness at once — no per-agent fan-out.

**Does vendor-skills work on Windows?**
Yes — it is developed and tested on Windows. CRLF and BOM in SKILL.md are
handled, paths go through `path.join`/`fs.cp` (recursive), and the lockfile is
written atomically.

**Does vendor-skills wire skills into my agent?**
No. vendor-skills manages skill *files* under the skills root (default
`.agents/skills`); pointing a specific agent at that directory is the agent's
configuration (most read `.agents/skills/` natively). Keeping distribution
separate from integration keeps vendor-skills agnostic.

## Roadmap

- **Drift detection** — flag local edits to an installed skill versus its
  pinned tree (`vendor-skills status`).
- **Malicious-pattern scan gate** — screen SKILL.md bodies at install time for
  dangerous commands and exfiltration URLs before a skill enters the tree.
- **Private-git auth helpers** — smooth credential setup for self-hosted
  remotes in CI.
- **`update --dry-run`** — show pending old → new pins without touching disk.

## License

[MIT](./LICENSE) — Copyright (c) 2026 vendor-skills contributors
