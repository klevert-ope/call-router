-- Timestamps are Unix milliseconds; JSON is stored as validated text.
CREATE TABLE IF NOT EXISTS sessions (
  primary_call_id TEXT PRIMARY KEY NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  lease_owner TEXT,
  lease_until REAL,
  private_request_id TEXT,
  last_dtmf_sequence INTEGER NOT NULL DEFAULT -1,
  updated_at REAL NOT NULL DEFAULT (unixepoch('subsec')*1000)
);
CREATE INDEX IF NOT EXISTS sessions_operator_identity ON sessions (json_extract(data,'$.operator.identity'));
CREATE INDEX IF NOT EXISTS sessions_active_vapi ON sessions (json_extract(data,'$.operator.vapiCallId')) WHERE json_extract(data,'$.phase')<>'ended';
CREATE INDEX IF NOT EXISTS sessions_active_updated ON sessions (updated_at) WHERE json_extract(data,'$.phase')<>'ended';
CREATE INDEX IF NOT EXISTS sessions_deadlines ON sessions (json_extract(data,'$.commandDeadline')) WHERE json_extract(data,'$.phase')<>'ended';
CREATE INDEX IF NOT EXISTS sessions_private_requests ON sessions (primary_call_id) WHERE private_request_id IS NOT NULL AND json_extract(data,'$.phase')<>'ended';
CREATE INDEX IF NOT EXISTS sessions_ended_updated ON sessions (updated_at) WHERE json_extract(data,'$.phase')='ended';
CREATE TABLE IF NOT EXISTS contacts (
  label TEXT PRIMARY KEY NOT NULL,
  number TEXT NOT NULL CHECK (length(number) BETWEEN 3 AND 16 AND substr(number,1,1)='+'
    AND substr(number,2,1) BETWEEN '1' AND '9' AND substr(number,2) NOT GLOB '*[^0-9]*'),
  updated_at REAL NOT NULL DEFAULT (unixepoch('subsec')*1000)
);
CREATE TABLE IF NOT EXISTS tool_results (
  vapi_call_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  reply TEXT CHECK (reply IS NULL OR json_valid(reply)),
  PRIMARY KEY (vapi_call_id,tool_call_id)
);
CREATE TABLE IF NOT EXISTS pin_attempts (
  call_id TEXT PRIMARY KEY NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at REAL NOT NULL DEFAULT ((unixepoch('subsec')*1000)+3600000)
);
CREATE TABLE IF NOT EXISTS call_attempts (
  attempt_id TEXT PRIMARY KEY NOT NULL,
  primary_call_id TEXT NOT NULL REFERENCES sessions(primary_call_id),
  role TEXT NOT NULL CHECK (role IN ('destination','operator')),
  data TEXT NOT NULL CHECK (json_valid(data)),
  updated_at REAL NOT NULL DEFAULT (unixepoch('subsec')*1000)
);
CREATE INDEX IF NOT EXISTS call_attempts_primary ON call_attempts (primary_call_id);
CREATE INDEX IF NOT EXISTS call_attempts_vapi ON call_attempts (json_extract(data,'$.vapiCallId')) WHERE role='operator';
