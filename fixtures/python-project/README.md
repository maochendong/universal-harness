# python-project fixture

A small, original Python fixture project for Universal Harness cross-stack
E2E tests (plan Task 26). It needs no network access and no third-party
packages: the test suite uses only the standard-library `unittest` runner
(`PYTHONPATH=src python3 -m unittest discover -s tests`).

The E2E suite covers this stack at the detection and scan level -- stack
identification, file classification, component grouping and pack lock pinning
-- and never assumes a Python interpreter exists on the host, so the fixture
content is scanned but not executed there.
