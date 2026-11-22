# mend: one patch tool for every AI edit format

![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four
formats, and `mend` reads all of them: a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON. Every file is
changed or nothing is.

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file; when absent or `-`, the patch is read from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`, `json`; `auto` (the
  default) detects it: `*** Begin Patch` is V4A, a leading `[` or `{` is JSON, a
  `<<<<<<< SEARCH` line is SEARCH/REPLACE, a `diff --git` / `---` + `+++` pair is a unified diff.
- `--check` does everything but write: same output and exit code, no file created, changed or
  deleted.
- `--strict` matches lines exactly (tier 0 only).

## Matching: three tiers

An old block is found at the first tier where it occurs at least once:

- **tier 0** — every line equal;
- **tier 1** — every line equal once trailing spaces and tabs are removed from both;
- **tier 2** — every line equal once leading and trailing spaces and tabs are removed, with the
  replacement re-indented from the patch's indent to the file's own indent.

That is what makes drifted whitespace, wrong line numbers and re-indented pastes apply cleanly
instead of failing. A context line is always written as the file's own matched line, never the
patch's.

## Formats

- **Unified diff** — hunks apply in order to the result of the ones before; a hunk takes the
  occurrence nearest to its (wrong) line number, so `@@ -42,5` still lands on the right block.
  Creations, deletions and renames (`rename from`/`rename to`, `new`/`deleted file mode`,
  `/dev/null`) are supported, with `R old -> new` lines for moves. `\ No newline at end of file`
  controls the final line break; CRLF files keep CRLF.
- **SEARCH/REPLACE** — the path is the nearest non-blank, non-fence line above the block (or the
  previous block's path); old text must occur exactly once or the block fails `ambiguous`.
- **V4A** — `*** Add/Delete/Update File`, `*** Move to:`, `@@` anchors and `*** End of File`
  chunks, applied with a cursor that walks the file in order so repeated blocks land in sequence.
- **JSON** — one array of edit objects, or one edit object per line: `create` (byte-for-byte),
  `str_replace` (exactly once, else `no-match`/`ambiguous`), `insert` at a line number.

## Output and atomicity

- Exit `0`: one line per changed path (`A`/`D`/`M`, `R old -> new` for moves, byte order), then
  `ok: <n> files`.
- Exit `1`: one `error: <code> <path>` line per failed edit, in patch order, then
  `failed: <k> of <n> edits`. A failed edit changes nothing and the edits after it still run;
  when any edit failed, **no file is written at all**.
- Exit `2`: exactly one line — `error: usage`, `error: no-patch`, `error: format`, or
  `error: parse <N>` — tried in that order.

Unsafe paths (empty, absolute, backslashes, empty/`.`/`..` segments) fail with `error: unsafe`.
Created files use LF and end with a line break unless the format says otherwise; changed files
keep their own line break and final-break state.

## Practice results

Node 22, standard library only — no dependencies.

```sh
node check.ts ../program/generator/practice.json   # kit practice set
```

- Practice set: **100 of 100 passed, score 1000**
- Practice trial-0 / trial-1 / trial-2: **100 of 100 each, score 1000**
- Two full practice runs produce byte-identical output (deterministic).

`runner.ts` is the kit's trial runner, kept as it is; `main.ts` hands a trial over to it when
`MAKEFUN_ENV_URL` is set.

## License

MIT — see [LICENSE](LICENSE).
