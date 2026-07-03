# Engineering Standards

Working document. The quality floor for Causent. Every component is built to pass a
review panel: **staff engineer** (correctness, simplicity), **senior data scientist +
causal-inference researcher** (statistical validity, no overclaiming), **top designer**
(trust, clarity), **director of product** (scope discipline, serves the wedge).

## Principles

1. **Clean over clever.** Explicit beats implicit. If a reviewer has to pause, rewrite it.
2. **Every line earns its place.** No dead abstraction, no speculative generality, no
   commented-out code. Delete before you add.
3. **Concise, not terse-to-the-point-of-cryptic.** Short functions, precise names.
   Avoid verbosity in code AND docs — a paragraph that restates the code is noise.
4. **Atomic, composable components.** Build bottom-up. Each component is independently
   testable and swappable so it can be pressured or replaced without touching the rest.
5. **Types are the contract.** Full typing (TS strict, Python type hints). No `any`.
6. **Errors are explicit and named.** No catch-all. Degenerate inputs return a defined
   result, never a crash or a fabricated number.
7. **Statistical honesty.** Estimates carry uncertainty; the code never presents a
   number as more certain than the math supports. (See `decision-graph.md`.)

## What a "component" is

A component is one **highly-impactful function or a tight set of functions** with a
single responsibility and a typed contract. It ships as a unit of:

```
  implement  →  unit test (golden data where numeric)  →  adversarial check  →  commit
```

- **Small surface:** one job, one export boundary; internals private.
- **Pure where possible:** deterministic inputs → outputs; side effects isolated.
- **Colocated tests:** `foo.ts` + `foo.test.ts` (or `test_foo.py`). Golden-data tests
  for anything numeric (assert recovery of a known truth, not just "doesn't throw").
- **Adversarial check:** a separate pass that tries to *break* the component — edge
  inputs, degenerate data, boundary values, wrong types, the failure the author didn't
  imagine. A component isn't done until a skeptic couldn't easily falsify it.
- **Doc header:** a short comment stating *why* + the contract + any non-obvious
  invariant. An ASCII diagram only when the flow is non-obvious. Not a restatement.

## Code conventions

- **Functions:** aim short; if it branches >5 ways or scrolls a screen, split it.
- **Naming:** name for behavior, not mechanism. No abbreviations that aren't domain terms.
- **DRY:** one source of truth per fact/logic; flag repetition aggressively (numeric code
  especially — one implementation of the statistics, never two that can drift).
- **No premature optimization; no premature abstraction.** Extract on the second use, not the first.
- **Comments explain why, code explains what.** If you need a comment to explain *what*,
  the code is unclear — fix the code.

## Documentation

- **Per component:** the short header above. Nothing more unless it earns it.
- **Per module/asset:** a living doc (e.g. `decision-graph.md`, `security-and-auth.md`)
  — the *why*, the model, the roadmap, open questions. Kept current with the code.
- **Diagrams:** ASCII for non-trivial data flow / state / pipeline; keep them accurate
  or delete them (a stale diagram is worse than none).

## Review gate (per component, before it lands)

- [ ] Single responsibility, typed contract, small surface.
- [ ] Golden-data / behavior test covering happy + degenerate + boundary.
- [ ] Adversarial check ran and passed (skeptic couldn't break it).
- [ ] No verbosity: no dead code, no comment that restates code, no unused abstraction.
- [ ] Statistical/security honesty where applicable (no overclaim, no RLS bypass).
- [ ] Would survive the panel (staff eng / data scientist + causal researcher / designer / product).

## Applying this

This document governs the project's own module/component folders. Every build task
(see the `tasks-*.jsonl` under `~/.gstack/projects/`) is decomposed into components that
each pass the review gate above before the next builds on it.
