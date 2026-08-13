# node-project fixture

A small, original Node.js fixture project for Universal Harness cross-stack
E2E tests (plan Task 26). It needs no network access and no third-party
dependencies: the test suite runs on the built-in `node --test` runner, which
the E2E harness exercises as the stack-layer gate declared by the Node pack.

Files under `src/` and `test/` are real, executable content; the fixture
itself is copied into a throwaway Git repository by the E2E tests and never
imported by this workspace.
