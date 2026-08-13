# java-project fixture

A small, original Java fixture project for Universal Harness cross-stack E2E
tests (plan Task 26). It needs no network access: the build declares no
external dependencies, and the test is a plain `main`-method assertion class
(`java src/test/java/example/GreetingTest.java` once compiled), so no test
framework download is ever required.

The E2E suite covers this stack at the detection and scan level -- stack
identification, file classification, component grouping and pack lock pinning
-- and never assumes a JDK exists on the host, so the fixture content is
scanned but not compiled there.
