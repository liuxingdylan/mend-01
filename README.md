# mend-01

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/liuxingdylan/mend-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/liuxingdylan/mend-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: it applies unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits to a tree of text files, matching lines at three tiers and writing every change or none. Node 22, standard library only, no install step.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is a patch file relative to the working directory (the root of the tree); when it is absent or `-`, the patch is read from standard input. `--format=NAME` forces one format (`unified`, `search-replace`, `v4a`, `json`); the default `auto` detects it. `--check` reports what would change without writing anything. `--strict` matches lines exactly (tier 0 only).

## What it does

- Reads all four formats AI models write: unified diffs (even with wrong line numbers), `<<<<<<< SEARCH` / `>>>>>>> REPLACE` blocks, V4A `*** Begin Patch` patches, and JSON edit objects (one array, or one object per line).
- Finds the lines each edit names at the first of three tiers: exact, ignoring trailing whitespace, ignoring leading and trailing whitespace (and re-indenting new lines to the file's indent at tier 2).
- Applies creates, deletes, changes and moves (including renames), keeping each file's CRLF/LF style and final line break; a `\ No newline at end of file` marker is honoured.
- Atomic: every edit runs against the tree as earlier edits left it, a failed edit changes nothing, and when any edit fails no file is written at all. Exit 0 prints one line per changed file (`A`/`D`/`M`, or `R old -> new` for a move) plus `ok: <n> files`; exit 1 lists every failed edit; exit 2 reports usage, missing patch, undetected format or parse errors.

## Quick start

```sh
# apply a unified diff to the tree in the current directory
node main.ts fix.patch

# preview a SEARCH/REPLACE patch without writing
node main.ts --check edit.patch

# pipe a V4A patch in, matching lines exactly
cat change.patch | node main.ts --strict --format=v4a -

# apply JSON edits
node main.ts --format=json edits.jsonl
```

## Files

- `main.ts` — the whole CLI (Node 22, standard library only).
- `runner.ts` — the trial runner the grader uses; keep as is.
- `check.ts` — runs the kit's 100 public practice checks against `main.ts`.
- `SPEC.md` — the full specification this tool implements.

Practice checks: 100/100 (`node check.ts <kit>/program/generator/practice.json`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=zzj73w81&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
