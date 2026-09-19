import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { before, test } from "node:test";
import { installSkill, installSkillFrozen, uninstallSkill, updateSkills } from "../src/git.js";
import { lockPath, readLock, writeLock } from "../src/lock.js";
import { verifySkills } from "../src/verify.js";
import { validateSkillDir } from "../src/validate.js";
import { UsageError } from "../src/errors.js";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EXAMPLES = join(PROJECT_ROOT, "example-skills");
const PDF_HELPER = join(EXAMPLES, "pdf-helper");
const BROKEN_SKILL = join(EXAMPLES, "broken-skill");

// Isolate git from any machine-global or system config; -c flags supply the
// identity needed to commit in fixtures.
let EMPTY_GITCONFIG: string;

before(async () => {
  const dir = await mkdtemp(join(tmpdir(), "vendor-skills-gitcfg-"));
  EMPTY_GITCONFIG = join(dir, "gitconfig");
  await writeFile(EMPTY_GITCONFIG, "", "utf8");
});

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG,
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function git(args: string[], cwd?: string): Promise<void> {
  await execFileAsync("git", args, { cwd, env: gitEnv() });
}

interface RepoEntry {
  src: string;
  dest: string;
}

/** Create a committed fixture git repository. dest "" copies src as the repo root. */
async function makeRepo(repoDir: string, entries: RepoEntry[]): Promise<string> {
  await rm(repoDir, { recursive: true, force: true });
  if (entries.length === 1 && entries[0].dest === "") {
    await cp(entries[0].src, repoDir, { recursive: true });
  } else {
    await mkdir(repoDir, { recursive: true });
    for (const e of entries) {
      await cp(e.src, join(repoDir, e.dest), { recursive: true });
    }
  }
  await git(["init", "-q", "-b", "main"], repoDir);
  await git(["add", "-A"], repoDir);
  await git(
    ["-c", "user.email=vendor-skills@example.com", "-c", "user.name=vendor-skills tests", "commit", "-q", "-m", "fixture"],
    repoDir,
  );
  return repoDir;
}

/** Add one more commit to an existing fixture repo, editing one file. */
async function addCommit(repoDir: string, file: string, text: string): Promise<void> {
  const target = join(repoDir, file);
  await mkdir(dirname(target), { recursive: true });
  const current = await readFile(target, "utf8").catch(() => "");
  await writeFile(target, current + text, "utf8");
  await git(["add", "-A"], repoDir);
  await git(
    ["-c", "user.email=vendor-skills@example.com", "-c", "user.name=vendor-skills tests", "commit", "-q", "-m", "second"],
    repoDir,
  );
}

async function revParseHead(repoDir: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoDir, env: gitEnv() });
  return stdout.trim();
}

async function freshBase(): Promise<{ base: string; dest: string }> {
  const base = await mkdtemp(join(tmpdir(), "vendor-skills-install-"));
  return { base, dest: join(base, ".agents", "skills") };
}

test("install: clones a local repo, auto-detects the skill, writes vendor-skills.lock", async () => {
  const { base, dest } = await freshBase();
  const repo = await makeRepo(join(base, "repo"), [{ src: PDF_HELPER, dest: "pdf-helper" }]);

  const result = await installSkill(repo, { dest });
  assert.equal(result.name, "pdf-helper");
  assert.ok(existsSync(join(dest, "pdf-helper", "SKILL.md")));
  assert.ok(!existsSync(join(dest, "pdf-helper", ".git")), ".git must not be copied");
  assert.ok(existsSync(lockPath(dest)), "the lockfile must be named vendor-skills.lock");
  assert.match(result.commit, /^[0-9a-f]{40,64}$/);

  const lock = await readLock(dest);
  assert.equal(lock.version, 1);
  assert.equal(lock.skills.length, 1);
  const entry = lock.skills[0];
  assert.equal(entry.name, "pdf-helper");
  assert.equal(entry.source.git, repo);
  assert.equal(entry.source.commit, result.commit);
  assert.equal(entry.source.subdir, undefined);
  assert.ok(!Number.isNaN(Date.parse(entry.installedAt)));

  const validation = await validateSkillDir(join(dest, "pdf-helper"));
  assert.ok(validation.valid, "installed skill must validate in its destination");
});

test("install: refuses to overwrite without force, honors --force", async () => {
  const { base, dest } = await freshBase();
  const repo = await makeRepo(join(base, "repo"), [{ src: PDF_HELPER, dest: "pdf-helper" }]);

  await installSkill(repo, { dest });
  await assert.rejects(installSkill(repo, { dest }), /already installed|--force/i);
  await installSkill(repo, { dest, force: true });
  assert.equal((await readLock(dest)).skills.length, 1);
});

test("install: --subdir selects a nested skill and is recorded in the lockfile", async () => {
  const { base, dest } = await freshBase();
  const repo = await makeRepo(join(base, "repo"), [{ src: PDF_HELPER, dest: "packages/deep/pdf-helper" }]);

  const result = await installSkill(repo, { dest, subdir: "packages/deep/pdf-helper" });
  assert.equal(result.name, "pdf-helper");
  assert.ok(existsSync(join(dest, "pdf-helper", "SKILL.md")));

  const entry = (await readLock(dest)).skills[0];
  assert.equal(entry.source.subdir, "packages/deep/pdf-helper");
});

test("install: --subdir without a SKILL.md fails with a clear message", async () => {
  const { base, dest } = await freshBase();
  const repo = await makeRepo(join(base, "repo"), [{ src: PDF_HELPER, dest: "pdf-helper" }]);
  await assert.rejects(installSkill(repo, { dest, subdir: "nope" }), /subdir .* does not contain a SKILL\.md/i);
});

test("install: multiple candidates fail with guidance to use --subdir", async () => {
  const { base, dest } = await freshBase();
  const repo = await makeRepo(join(base, "repo"), [
    { src: PDF_HELPER, dest: "one/pdf-helper" },
    { src: PDF_HELPER, dest: "two/pdf-helper" },
  ]);
  await assert.rejects(installSkill(repo, { dest }), (err: Error) =>
    /multiple skills found/.test(err.message) && /--subdir/.test(err.message) && /one.pdf-helper/.test(err.message),
  );
});

test("install: a skill at the repository root installs despite the random temp dir name", async () => {
  const { base, dest } = await freshBase();
  const repo = await makeRepo(join(base, "repo"), [{ src: PDF_HELPER, dest: "" }]);
  const result = await installSkill(repo, { dest });
  assert.equal(result.name, "pdf-helper");
  assert.ok((await validateSkillDir(join(dest, "pdf-helper"))).valid);
});

test("install: refuses invalid skills and leaves nothing behind", async () => {
  const { base, dest } = await freshBase();
  const repo = await makeRepo(join(base, "repo"), [{ src: BROKEN_SKILL, dest: "broken-skill" }]);
  await assert.rejects(installSkill(repo, { dest }), /refusing to install invalid skill/i);
  assert.ok(!existsSync(join(dest, "broken-skill")));
  assert.equal((await readLock(dest)).skills.length, 0);
});

test("install: friendly error when the repository has no SKILL.md", async () => {
  const { base, dest } = await freshBase();
  const repo = join(base, "repo");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "readme.txt"), "not a skill repo\n", "utf8");
  await git(["init", "-q", "-b", "main"], repo);
  await git(["add", "-A"], repo);
  await git(
    ["-c", "user.email=vendor-skills@example.com", "-c", "user.name=vendor-skills tests", "commit", "-q", "-m", "fixture"],
    repo,
  );
  await assert.rejects(installSkill(repo, { dest }), /no SKILL\.md found/i);
});

test("install: friendly error for a missing repository", async () => {
  const { base, dest } = await freshBase();
  await assert.rejects(
    installSkill(join(base, "does-not-exist"), { dest }),
    (err: Error) => /git clone failed/.test(err.message) && /check the repository url/i.test(err.message),
  );
});

test("uninstall: removes the directory and the lockfile entry", async () => {
  const { base, dest } = await freshBase();
  const repo = await makeRepo(join(base, "repo"), [{ src: PDF_HELPER, dest: "pdf-helper" }]);
  await installSkill(repo, { dest });

  await uninstallSkill("pdf-helper", { dest });
  assert.ok(!existsSync(join(dest, "pdf-helper")));
  assert.equal((await readLock(dest)).skills.length, 0);

  await assert.rejects(uninstallSkill("pdf-helper", { dest }), /not tracked by vendor-skills/i);
});

test("uninstall: refuses names that were never installed", async () => {
  const { base, dest } = await freshBase();
  await mkdir(dest, { recursive: true });
  await assert.rejects(uninstallSkill("ghost-skill", { dest }), /not tracked by vendor-skills/i);
});

// ---------------------------------------------------------------- frozen ---

test("frozen: restores the exact pinned commit and never touches the lock", async () => {
  const { base, dest } = await freshBase();
  const repo = await makeRepo(join(base, "repo"), [{ src: PDF_HELPER, dest: "pdf-helper" }]);
  const first = await installSkill(repo, { dest });

  // Add a newer commit upstream so "latest" differs from the pin, then
  // delete the installed directory as if re-cloning the project in CI.
  await addCommit(repo, "pdf-helper/SKILL.md", "\nUpstream added this line AFTER the pin.\n");
  const lockBefore = await readFile(lockPath(dest), "utf8");
  await rm(join(dest, "pdf-helper"), { recursive: true, force: true });

  // Restore by git URL (the recorded source) and by skill name; both must
  // land on the pinned commit, not the new HEAD.
  for (const ref of [repo, "pdf-helper"]) {
    const results = await installSkillFrozen(ref, { dest });
    assert.equal(results.length, 1);
    const r = results[0];
    assert.equal(r.name, "pdf-helper");
    assert.equal(r.commit, first.commit, "frozen must restore the pinned commit, not the new HEAD");
    assert.ok(existsSync(join(dest, "pdf-helper", "SKILL.md")));
    const text = await readFile(join(dest, "pdf-helper", "SKILL.md"), "utf8");
    assert.ok(!text.includes("AFTER the pin"), "frozen restore must not contain post-pin content");
    assert.ok((await validateSkillDir(join(dest, "pdf-helper"))).valid);
    assert.equal(await readFile(lockPath(dest), "utf8"), lockBefore, "frozen must never write the lockfile");
    await rm(join(dest, "pdf-helper"), { recursive: true, force: true });
  }

  // No-ref form restores every lock entry (the npm-ci shape).
  const all = await installSkillFrozen(undefined, { dest });
  assert.deepEqual(all.map((r) => r.name), ["pdf-helper"]);
  assert.equal(await readFile(lockPath(dest), "utf8"), lockBefore);
});

test("frozen: without a lockfile it fails with an exit-2 style usage error", async () => {
  const { base, dest } = await freshBase();
  await mkdir(dest, { recursive: true }); // root exists, no lock
  await assert.rejects(installSkillFrozen("pdf-helper", { dest }), (err: Error) => {
    assert.ok(err instanceof UsageError);
    return /--frozen requires a lockfile/i.test(err.message);
  });
});

test("frozen: a skill not in the lock fails with the locked names listed", async () => {
  const { base, dest } = await freshBase();
  const repo = await makeRepo(join(base, "repo"), [{ src: PDF_HELPER, dest: "pdf-helper" }]);
  await installSkill(repo, { dest });
  await assert.rejects(installSkillFrozen("not-locked", { dest }), (err: Error) => {
    assert.ok(err instanceof UsageError);
    return /"not-locked" is not pinned/i.test(err.message) && /pdf-helper/.test(err.message);
  });
});

test("frozen: an unreachable pinned commit errors with guidance", async () => {
  const { base, dest } = await freshBase();
  const repo = await makeRepo(join(base, "repo"), [{ src: PDF_HELPER, dest: "pdf-helper" }]);
  await installSkill(repo, { dest });
  await rm(join(dest, "pdf-helper"), { recursive: true, force: true });

  // Sabotage the pin: a commit that does not exist upstream.
  const lock = await readLock(dest);
  lock.skills[0].source.commit = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
  await writeLock(dest, lock);

  await assert.rejects(installSkillFrozen(undefined, { dest }), (err: Error) =>
    /unreachable/i.test(err.message) && /vendor-skills (install|update)/i.test(err.message),
  );
  assert.ok(!existsSync(join(dest, "pdf-helper")), "a failed frozen install must leave nothing behind");
});

test("frozen: the validation gate still refuses invalid pinned skills", async () => {
  const { base, dest } = await freshBase();
  const repo = await makeRepo(join(base, "repo"), [{ src: BROKEN_SKILL, dest: "broken-skill" }]);
  // Hand-craft a lock entry for a skill that could never pass a normal install.
  await writeLock(dest, {
    version: 1,
    skills: [
      {
        name: "broken-skill",
        source: { git: repo, subdir: "broken-skill", commit: await revParseHead(repo) },
        installedAt: new Date().toISOString(),
      },
    ],
  });
  await assert.rejects(installSkillFrozen("broken-skill", { dest }), /refusing to install invalid skill/i);
  assert.ok(!existsSync(join(dest, "broken-skill")));
});

// ---------------------------------------------------------------- update ---

test("update: re-pins to the new HEAD and reports old -> new", async () => {
  const { base, dest } = await freshBase();
  const repo = await makeRepo(join(base, "repo"), [{ src: PDF_HELPER, dest: "pdf-helper" }]);
  const first = await installSkill(repo, { dest });
  const oldSha = first.commit;

  await addCommit(repo, "pdf-helper/SKILL.md", "\nUPDATE-MARKER second commit body.\n");
  const newSha = await revParseHead(repo);
  assert.notEqual(oldSha, newSha);

  const results = await updateSkills(["pdf-helper"], { dest });
  assert.equal(results.length, 1);
  const r = results[0];
  assert.equal(r.outcome, "updated");
  assert.equal(r.oldCommit, oldSha);
  assert.equal(r.newCommit, newSha);

  const entry = (await readLock(dest)).skills[0];
  assert.equal(entry.source.commit, newSha, "the lock must carry the new pin");
  const text = await readFile(join(dest, "pdf-helper", "SKILL.md"), "utf8");
  assert.ok(text.includes("UPDATE-MARKER"), "the installed directory must be the new version");
});

test("update: no names updates every lock entry; up-to-date is a no-op", async () => {
  const { base, dest } = await freshBase();
  const repo = await makeRepo(join(base, "repo"), [{ src: PDF_HELPER, dest: "pdf-helper" }]);
  const first = await installSkill(repo, { dest });

  let results = await updateSkills(undefined, { dest });
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, "up-to-date");
  assert.equal((await readLock(dest)).skills[0].source.commit, first.commit);

  await addCommit(repo, "pdf-helper/SKILL.md", "\nUPDATE-MARKER all update.\n");
  results = await updateSkills(undefined, { dest });
  assert.equal(results[0].outcome, "updated");
  assert.equal((await readLock(dest)).skills[0].source.commit, await revParseHead(repo));
});

test("update: a hand-installed skill (no lock entry) is skipped, not fatal", async () => {
  const { base, dest } = await freshBase();
  const repo = await makeRepo(join(base, "repo"), [{ src: PDF_HELPER, dest: "pdf-helper" }]);
  await installSkill(repo, { dest });
  await cp(PDF_HELPER, join(dest, "handmade"), { recursive: true });

  const results = await updateSkills(["handmade"], { dest });
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, "skipped");
  assert.match(results[0].message ?? "", /not tracked by vendor-skills/i);
  assert.ok(existsSync(join(dest, "handmade", "SKILL.md")), "the hand-installed directory must be left alone");
});

test("update: validation gate failure keeps the old pin and the old directory", async () => {
  const { base, dest } = await freshBase();
  const repo = await makeRepo(join(base, "repo"), [{ src: PDF_HELPER, dest: "pdf-helper" }]);
  const first = await installSkill(repo, { dest });

  // Break the skill upstream: empty the body -> SKILL_BODY_EMPTY.
  const skillMd = join(repo, "pdf-helper", "SKILL.md");
  const original = await readFile(skillMd, "utf8");
  const frontmatter = original.split("---\n").slice(0, 2).join("---\n") + "---\n";
  await writeFile(skillMd, frontmatter, "utf8"); // frontmatter only, empty body
  await git(["add", "-A"], repo);
  await git(
    ["-c", "user.email=vendor-skills@example.com", "-c", "user.name=vendor-skills tests", "commit", "-q", "-m", "broken"],
    repo,
  );

  const results = await updateSkills(undefined, { dest });
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, "failed");
  assert.match(results[0].message ?? "", /refusing to install invalid skill/i);
  assert.equal((await readLock(dest)).skills[0].source.commit, first.commit, "the lock must keep the old pin");
  const text = await readFile(join(dest, "pdf-helper", "SKILL.md"), "utf8");
  assert.ok(text.includes("# PDF helper"), "the old directory content must survive");
});

// ---------------------------------------------------------------- verify ---

test("verify: happy path - every lock entry present and valid", async () => {
  const { base, dest } = await freshBase();
  const repo = await makeRepo(join(base, "repo"), [{ src: PDF_HELPER, dest: "pdf-helper" }]);
  await installSkill(repo, { dest });

  const report = await verifySkills(dest);
  assert.ok(report.ok);
  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].name, "pdf-helper");
  assert.equal(report.entries[0].status, "ok");
  assert.deepEqual(report.untracked, []);
});

test("verify: a missing skill directory fails the gate", async () => {
  const { base, dest } = await freshBase();
  const repo = await makeRepo(join(base, "repo"), [{ src: PDF_HELPER, dest: "pdf-helper" }]);
  await installSkill(repo, { dest });
  await rm(join(dest, "pdf-helper"), { recursive: true, force: true });

  const report = await verifySkills(dest);
  assert.ok(!report.ok);
  assert.equal(report.entries[0].status, "missing");
  assert.match(report.entries[0].notes, /directory not found/i);
});

test("verify: an invalid locked skill fails the gate", async () => {
  const { base, dest } = await freshBase();
  const repo = await makeRepo(join(base, "repo"), [{ src: PDF_HELPER, dest: "pdf-helper" }]);
  await installSkill(repo, { dest });
  // Hand-corrupt the installed copy so it no longer validates.
  const skillMd = join(dest, "pdf-helper", "SKILL.md");
  await writeFile(skillMd, (await readFile(skillMd, "utf8")).replace("name: pdf-helper", "name: Pdf_Helper"), "utf8");

  const report = await verifySkills(dest);
  assert.ok(!report.ok);
  assert.equal(report.entries[0].status, "invalid");
  assert.ok(report.entries[0].errors > 0);
  assert.match(report.entries[0].notes, /SKILL_NAME_INVALID/);
});

test("verify: an untracked skill directory is a warning, the gate still passes", async () => {
  const { base, dest } = await freshBase();
  const repo = await makeRepo(join(base, "repo"), [{ src: PDF_HELPER, dest: "pdf-helper" }]);
  await installSkill(repo, { dest });
  await cp(PDF_HELPER, join(dest, "extra-skill"), { recursive: true });

  const report = await verifySkills(dest);
  assert.ok(report.ok, "untracked skills are warnings only");
  assert.deepEqual(report.untracked.map((u) => u.name), ["extra-skill"]);
});

test("verify: without a lockfile there is nothing to verify", async () => {
  const { base, dest } = await freshBase();
  await mkdir(dest, { recursive: true });
  await assert.rejects(verifySkills(dest), /no lockfile at .* nothing to verify/i);
});
