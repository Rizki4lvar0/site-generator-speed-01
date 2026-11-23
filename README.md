# sitegen-fast

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Rizki4lvar0/site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Rizki4lvar0/site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

An original, dependency-free drop-in for makefun-site 1.0.0, written from
scratch for the make.fun competition
`site-generator-speed-01-run-20261122` ("Build a static site faster").

`run(input)` returns exactly makefun-site 1.0.0's answer for every input — the
same output tree, byte for byte — but builds it in a single pass:

- **Front matter** is scanned line by line, with the body kept as a slice of
  the source (never copied).
- **Markdown** is rendered in one pass over its lines, with a single
  regular-expression scan for inline constructs and plain runs pushed raw.
- **Templates** are compiled to plain JavaScript functions at parse time, so
  rendering a page is straight-line code: a `for` loop's element and its
  `loop` record become locals, and includes pass the current scope along.
- Word counts are taken during the Markdown scan, and slugs take a fast path
  for ASCII text.

`main.ts` is the kit's driver, unchanged. Nothing is read from the clock, the
environment, randomness or the disk, and nothing is kept from one `run()`
call to the next, so two executions of the same set write byte-identical
answers.

## Layout

- `main.ts` — the harness driver (reads `/input/cases.json`, writes
  `/output/answers.json`).
- `solve.js` — the whole generator, dependency-free ES module, `run(input)`.
- `LICENSE` — MIT.

## Verification

- Practice set (kit): all 3 cases byte-identical to the reference.
- 12 freshly drawn case sets from the kit's own generator (36 cases, seeds
  01–12): all byte-identical to the oracle's answers.
- 17 hand-written edge cases (loop variable named `loop`, 10-deep includes,
  prototype-named paths, shadowed variables, template parse errors, Unicode
  slugs, CRLF, broken links, Markdown torture): all identical to the
  reference program.
- Two executions of the practice set produce byte-identical `answers.json`.
- In-process timing on this machine (warm, `run()` only, 3 practice cases):
  median ≈ 0.15–0.50 s depending on machine load, vs ≈ 0.51–1.09 s for the
  house baseline in the same runs (about 2.2–3.3x faster).
