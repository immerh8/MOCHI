# Fuzz regression inputs

Inputs a fuzz target crashed on, kept byte for byte, one directory per target.
`crates/mochi-testkit/tests/c8_salvage.rs::salvage_fuzz_regression_inputs` runs
every file in `salvage_scan/` through `exercise_salvage_scan` on stable Rust.
CI's `salvage_scan` fuzz job also seeds from `salvage_scan/`. Files are named as libFuzzer wrote them (`crash-<sha1>`). Add a hand-built test
for the same case next to the one that runs the file.

| File | Found | Fixed by |
|---|---|---|
| `salvage_scan/crash-599502c9474a11dc9cd4110c9d26a8c296b1c513` | CI run 38452009022 (job 115485024551) | a salvaged chain holds only commits the scan confirmed (`c8_salvage.rs::salvage_19`; plan W12 "Fix (2026-10-13)") |
