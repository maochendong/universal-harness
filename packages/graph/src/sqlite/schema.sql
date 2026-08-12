-- Materialized graph view schema. This database is a disposable query
-- projection of the Git-native ledger: it stores no exclusive authoritative
-- state and can be dropped and rebuilt from committed ledger records at any
-- time. Bump GRAPH_SCHEMA_VERSION in database.ts when this file changes.
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operations (
  ledger_operation_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL UNIQUE,
  workflow_operation_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  baseline_commit TEXT NOT NULL,
  digest TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence REAL NOT NULL,
  digest TEXT NOT NULL,
  locator TEXT,
  iteration_id TEXT NOT NULL,
  record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS nodes_type_idx ON nodes (type);
CREATE INDEX IF NOT EXISTS nodes_status_idx ON nodes (status);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence REAL NOT NULL,
  digest TEXT NOT NULL,
  record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS edges_source_idx ON edges (source_id);
CREATE INDEX IF NOT EXISTS edges_target_idx ON edges (target_id);
CREATE INDEX IF NOT EXISTS edges_type_idx ON edges (type);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  project_id TEXT NOT NULL,
  iteration_id TEXT NOT NULL,
  workflow_operation_id TEXT NOT NULL,
  ledger_operation_id TEXT NOT NULL,
  operation_sequence INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_iteration_idx ON events (iteration_id, operation_sequence, sequence);
CREATE INDEX IF NOT EXISTS events_workflow_idx ON events (workflow_operation_id, operation_sequence, sequence);
