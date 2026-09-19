---
name: Broken_Skill
version: 1.2.3
allowed-tools: Bash
---

# Broken skill

This skill is intentionally invalid. It is used by the vendor-skills test suite to
assert that the validator catches broken frontmatter:

- `name` is not lowercase kebab-case, and it does not match the directory
  name (`broken-skill`),
- `description` is missing entirely,
- `version` is not a known frontmatter key.

Do not fix this file without also updating test/validate.test.ts.
