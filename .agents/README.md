# Agent skill sources

These repository-local skills are required by the root AGENTS.md when their
triggers apply. Keep vendored content byte-for-byte identical to its source.

| Skills                                                                       | Source                                                                                                                   | Revision                                   |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| github-actions-hardening, github-actions-runtime-upgrade-conventions, codeql | [github/awesome-copilot](https://github.com/github/awesome-copilot/tree/ff784ad85c37d6f93c0194ea16602197693b5786/skills) | `ff784ad85c37d6f93c0194ea16602197693b5786` |
| writing-for-agents                                                           | Owner-provided local skill, copied with permission                                                                       | Snapshot 2026-10-06                        |

The awesome-copilot skills include their reference directories and the upstream
[MIT license](skills/LICENSE-awesome-copilot). The writing skill is an exact
snapshot of the owner's supplied skill, including SKILL-MECHANICS.md and agent
metadata; no upstream license or repository was supplied for that snapshot.

## Updates

Choose and review one immutable upstream commit for all awesome-copilot skills.
Replace their complete directories and the upstream license from that revision.
Record the new commit here. For writing-for-agents, obtain an updated owner
snapshot and record its date. Apply the same reviewed snapshots to both the
Action template and dev-tools. Check every relative reference and inspect the
skill diff for changed instructions before running the repository checks.

Skills are reference material, excluded from formatting, linting and CodeQL.
This file and AGENTS.md remain part of the repository formatting checks. The
dev-tools package includes only its configured exports, not agent skills.
