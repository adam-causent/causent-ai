# Causent Causal Engine

Pure-numpy causal engine (numpy-only in shipped code; scipy is a **test-only** oracle).
Built as atomic components per `docs/ENGINEERING.md`. Data model + rules:
`docs/designs/decision-graph.md`.

Components: t_ppf (C1) · segmented_ols (C2) · step_ci (C3) · its_readout (C4) ·
before_after_14d (C5) · placebo_in_time (C6) · power_mde (C7) · belief_direction (C8) ·
batch_readout (C9). Each: pure, typed, golden-data tested, adversarially checked.

Run: `pip install -r requirements-dev.txt && pytest`
