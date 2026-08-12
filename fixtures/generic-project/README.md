# generic-project fixture

A stack-neutral fixture project for Universal Harness integration tests. It
intentionally has no build system, package manifest or VCS metadata so the
`harness new` and `harness adopt` flows can exercise detection and staging
against deterministic content without picking up real toolchain behavior.

Files under `src/` and `tests/` are plain sample content; nothing here is
executed.
