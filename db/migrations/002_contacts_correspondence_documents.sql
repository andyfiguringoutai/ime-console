-- ============================================================================
-- 002 — structured contacts, correspondence log, real document storage
--
-- Motivation, straight from the source export:
--   * "expert@diabloortho.com / busfieldmd@gmail.com"  -> two emails, one column
--   * "Lou Lor - Case Manager", "Ms. Lou Lor"          -> a person + a role, spelled twice
--   * "Benjamin/Grave Busfield"                        -> two people, one column
--   * '5597088708', '+1 805 888 1018', '(650) 410-0078 ' -> four phone formats
-- A flat TEXT column cannot represent any of that. These tables can.
-- ============================================================================

-- A named human at the practice. The scheduler is usually who you actually deal
-- with, and they outlast any single phone number.
CREATE TABLE contact_person (
  id           INTEGER PRIMARY KEY,
  physician_id INTEGER NOT NULL REFERENCES physician(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  role         TEXT,                       -- 'Case Manager', 'Office Manager', 'Scheduler'
  is_primary   INTEGER NOT NULL DEFAULT 0,
  is_active    INTEGER NOT NULL DEFAULT 1,
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_person_physician ON contact_person(physician_id);

-- Every way to reach someone. Attachable to the practice, to a named person, or
-- to a specific office (scheduling lines are usually per-site).
CREATE TABLE contact_method (
  id                INTEGER PRIMARY KEY,
  physician_id      INTEGER NOT NULL REFERENCES physician(id) ON DELETE CASCADE,
  contact_person_id INTEGER REFERENCES contact_person(id) ON DELETE SET NULL,
  location_id       INTEGER REFERENCES practice_location(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('email','phone','fax','website','portal')),
  purpose           TEXT NOT NULL DEFAULT 'general'
                      CHECK (purpose IN ('general','scheduling','billing','records','clinical','reports')),
  value             TEXT NOT NULL,         -- exactly as entered; never destroy the original
  value_normalized  TEXT,                  -- E.164 / lowercased / canonical URL — for dedupe and matching
  is_primary        INTEGER NOT NULL DEFAULT 0,
  is_active         INTEGER NOT NULL DEFAULT 1,
  verified_at       TEXT,
  verified_by       TEXT,
  notes             TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_method_physician ON contact_method(physician_id, kind);
CREATE INDEX idx_method_norm      ON contact_method(value_normalized);

-- Every interaction. Links to the outreach item it served, so a call sheet entry
-- and the record of the call are the same story rather than two.
CREATE TABLE correspondence (
  id                INTEGER PRIMARY KEY,
  physician_id      INTEGER NOT NULL REFERENCES physician(id) ON DELETE CASCADE,
  contact_person_id INTEGER REFERENCES contact_person(id) ON DELETE SET NULL,
  outreach_id       INTEGER REFERENCES outreach(id) ON DELETE SET NULL,
  direction         TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  channel           TEXT NOT NULL CHECK (channel IN ('email','phone','fax','portal','meeting','note')),
  subject           TEXT,
  body              TEXT,
  occurred_at       TEXT NOT NULL DEFAULT (datetime('now')),
  logged_by         TEXT NOT NULL DEFAULT 'unknown',
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_corr_physician ON correspondence(physician_id, occurred_at);
CREATE INDEX idx_corr_outreach  ON correspondence(outreach_id);

CREATE TABLE correspondence_attachment (
  correspondence_id INTEGER NOT NULL REFERENCES correspondence(id) ON DELETE CASCADE,
  document_id       INTEGER NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  PRIMARY KEY (correspondence_id, document_id)
);

-- ---------------------------------------------------------------- documents
-- SQLite can't extend a CHECK constraint in place, so the table is rebuilt.
CREATE TABLE document_new (
  id            INTEGER PRIMARY KEY,
  physician_id  INTEGER NOT NULL REFERENCES physician(id) ON DELETE CASCADE,
  doc_type      TEXT NOT NULL CHECK (doc_type IN
                  ('cv','licensure','contract','scheduling','fee_schedule','w9','insurance','report_sample','other')),
  title         TEXT,
  filename      TEXT,
  mime_type     TEXT,
  byte_size     INTEGER,
  storage_path  TEXT,
  sha256        TEXT,                      -- integrity + dedupe: the same CV uploaded twice is one file
  version       INTEGER NOT NULL DEFAULT 1,
  supersedes_id INTEGER REFERENCES document_new(id) ON DELETE SET NULL,
  is_current    INTEGER NOT NULL DEFAULT 1,
  effective_on  TEXT,
  expires_on    TEXT,                      -- licensure/insurance expiry -> feeds the action queue
  uploaded_by   TEXT,
  uploaded_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO document_new (id,physician_id,doc_type,title,filename,mime_type,byte_size,storage_path,expires_on,uploaded_by,uploaded_at)
  SELECT id,physician_id,doc_type,title,filename,mime_type,byte_size,storage_path,expires_on,uploaded_by,uploaded_at FROM document;
DROP TABLE document;
ALTER TABLE document_new RENAME TO document;
CREATE INDEX idx_doc_physician ON document(physician_id, doc_type);
CREATE INDEX idx_doc_current   ON document(physician_id, doc_type, is_current);
CREATE INDEX idx_doc_expiry    ON document(expires_on) WHERE expires_on IS NOT NULL;
CREATE INDEX idx_doc_sha       ON document(sha256);

-- A fee rate should be able to point at the PDF it came from.
ALTER TABLE fee ADD COLUMN document_id INTEGER REFERENCES document(id) ON DELETE SET NULL;
ALTER TABLE fee ADD COLUMN source_note TEXT;

-- ---------------------------------------------------------------- views
CREATE VIEW v_physician_contact AS
SELECT p.id AS physician_id, p.full_name,
       cm.kind, cm.purpose, cm.value, cm.value_normalized, cm.is_primary,
       cp.name AS person_name, cp.role AS person_role,
       pl.city AS location_city
FROM physician p
JOIN contact_method cm ON cm.physician_id = p.id AND cm.is_active = 1
LEFT JOIN contact_person cp ON cp.id = cm.contact_person_id
LEFT JOIN practice_location pl ON pl.id = cm.location_id;

-- Credentials that have lapsed or will shortly. This is an action queue.
CREATE VIEW v_expiring_documents AS
SELECT d.id, d.physician_id, p.full_name, d.doc_type, d.title, d.expires_on,
       CAST(julianday(d.expires_on) - julianday('now') AS INTEGER) AS days_remaining
FROM document d JOIN physician p ON p.id = d.physician_id
WHERE d.expires_on IS NOT NULL AND d.is_current = 1 AND p.is_active = 1
ORDER BY d.expires_on;
