-- ============================================================================
--  IME Network — provider management & coverage assessment
--  SQLite dialect. Portable to Postgres with minimal edits (see README).
--
--  DESIGN NOTE: coverage is NEVER stored. It is derived at query time from
--  practice_location + region + coverage_target. Storing it would let the map
--  drift from the data, which is the failure mode this system exists to prevent.
-- ============================================================================
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- reference
CREATE TABLE specialty (
  id         INTEGER PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,           -- PSYCH | ORTHO | NEURO | CARDIO | OTHER
  name       TEXT NOT NULL,
  is_core    INTEGER NOT NULL DEFAULT 0,     -- the four that drive coverage maths
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- A drive-time catchment, not a census area. One pin at its commercial heart;
-- coverage is measured as travel time to that pin.
CREATE TABLE region (
  id                INTEGER PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  pin_label         TEXT NOT NULL,
  pin_lat           REAL NOT NULL,
  pin_lng           REAL NOT NULL,
  population_m      REAL,
  is_flyin_corridor INTEGER NOT NULL DEFAULT 0,
  effective_mph     REAL NOT NULL DEFAULT 48,
  covers            TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------- physician
CREATE TABLE physician (
  id                   INTEGER PRIMARY KEY,
  source_id            TEXT UNIQUE,
  full_name            TEXT NOT NULL,
  credentials          TEXT,
  primary_specialty_id INTEGER REFERENCES specialty(id),
  specialty_detail     TEXT,
  preference           TEXT CHECK (preference IN ('Preferred','Secondary','Do Not Use')),
  point_of_contact     TEXT,
  email                TEXT,
  phone                TEXT,
  website              TEXT,
  is_qme               INTEGER NOT NULL DEFAULT 0,
  performs_ime         INTEGER NOT NULL DEFAULT 1,
  is_active            INTEGER NOT NULL DEFAULT 1,
  notes                TEXT,
  source_address_raw   TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_physician_specialty ON physician(primary_specialty_id);
CREATE INDEX idx_physician_active    ON physician(is_active);

CREATE TABLE physician_specialty (
  physician_id INTEGER NOT NULL REFERENCES physician(id) ON DELETE CASCADE,
  specialty_id INTEGER NOT NULL REFERENCES specialty(id),
  PRIMARY KEY (physician_id, specialty_id)
);

-- ---------------------------------------------------------------- locations
-- THE CENTRAL TABLE. One row per place a physician will actually sit.
-- Coverage is a property of a location, not of a physician.
CREATE TABLE practice_location (
  id                  INTEGER PRIMARY KEY,
  physician_id        INTEGER NOT NULL REFERENCES physician(id) ON DELETE CASCADE,
  label               TEXT,
  address_line        TEXT,
  city                TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'CA',
  postal_code         TEXT,
  lat                 REAL,
  lng                 REAL,
  geocode_source      TEXT NOT NULL DEFAULT 'city_centroid'
                        CHECK (geocode_source IN ('city_centroid','zip_centroid','manual','geocoder','unknown')),
  site_type           TEXT NOT NULL DEFAULT 'office'
                        CHECK (site_type IN ('office','flyin')),
  confirmation_status TEXT NOT NULL DEFAULT 'needs_confirm'
                        CHECK (confirmation_status IN ('confirmed','assumed','needs_confirm','out_of_state')),
  confirmed_by        TEXT,
  confirmed_at        TEXT,
  is_active           INTEGER NOT NULL DEFAULT 1,
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_loc_physician ON practice_location(physician_id);
CREATE INDEX idx_loc_geo       ON practice_location(lat, lng);
CREATE INDEX idx_loc_conf      ON practice_location(confirmation_status);

-- ---------------------------------------------------------------- commercial
CREATE TABLE fee (
  id             INTEGER PRIMARY KEY,
  physician_id   INTEGER NOT NULL REFERENCES physician(id) ON DELETE CASCADE,
  service_code   TEXT NOT NULL,
  description    TEXT,
  amount_cents   INTEGER NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'USD',
  unit           TEXT NOT NULL DEFAULT 'flat' CHECK (unit IN ('flat','hour','page','case')),
  effective_from TEXT,
  effective_to   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_fee_physician ON fee(physician_id, service_code);

CREATE TABLE document (
  id           INTEGER PRIMARY KEY,
  physician_id INTEGER NOT NULL REFERENCES physician(id) ON DELETE CASCADE,
  doc_type     TEXT NOT NULL CHECK (doc_type IN ('cv','licensure','contract','scheduling','other')),
  title        TEXT,
  filename     TEXT,
  mime_type    TEXT,
  byte_size    INTEGER,
  storage_path TEXT,
  expires_on   TEXT,
  uploaded_by  TEXT,
  uploaded_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_doc_physician ON document(physician_id, doc_type);

-- ---------------------------------------------------------------- targets
CREATE TABLE coverage_target (
  region_id    INTEGER NOT NULL REFERENCES region(id) ON DELETE CASCADE,
  specialty_id INTEGER NOT NULL REFERENCES specialty(id),
  target_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (region_id, specialty_id)
);

CREATE TABLE region_radius_override (
  region_id INTEGER PRIMARY KEY REFERENCES region(id) ON DELETE CASCADE,
  minutes   INTEGER NOT NULL
);

CREATE TABLE setting (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------- workflow
CREATE TABLE outreach (
  id           INTEGER PRIMARY KEY,
  physician_id INTEGER REFERENCES physician(id) ON DELETE CASCADE,
  region_id    INTEGER REFERENCES region(id),
  specialty_id INTEGER REFERENCES specialty(id),
  purpose      TEXT NOT NULL CHECK (purpose IN ('confirm_coverage','recruit','fee_update','credential_check','other')),
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','declined','deferred')),
  priority     INTEGER NOT NULL DEFAULT 3,
  assigned_to  TEXT,
  due_on       TEXT,
  prompt       TEXT,
  outcome_note TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at  TEXT
);
CREATE INDEX idx_outreach_status ON outreach(status, priority);

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY,
  entity      TEXT NOT NULL,
  entity_id   INTEGER NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('create','update','delete')),
  actor       TEXT NOT NULL DEFAULT 'system',
  before_json TEXT,
  after_json  TEXT,
  at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id, at);

-- ---------------------------------------------------------------- views
CREATE VIEW v_provider_site AS
SELECT pl.id AS location_id, p.id AS physician_id, p.full_name, p.credentials,
       p.preference, p.is_qme, p.is_active AS physician_active,
       s.code AS specialty_code, s.name AS specialty_name, s.is_core,
       pl.label, pl.city, pl.state, pl.postal_code, pl.lat, pl.lng,
       pl.geocode_source, pl.site_type, pl.confirmation_status,
       pl.is_active AS location_active
FROM practice_location pl
JOIN physician p ON p.id = pl.physician_id
LEFT JOIN specialty s ON s.id = p.primary_specialty_id;

CREATE VIEW v_unconfirmed_coverage AS
SELECT p.id AS physician_id, p.full_name, p.phone, p.email,
       s.code AS specialty_code,
       COUNT(pl.id) AS location_count,
       SUM(CASE WHEN pl.confirmation_status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed_count
FROM physician p
LEFT JOIN specialty s ON s.id = p.primary_specialty_id
LEFT JOIN practice_location pl ON pl.physician_id = p.id AND pl.is_active = 1
WHERE p.is_active = 1
GROUP BY p.id
HAVING location_count = 0 OR confirmed_count < location_count;
