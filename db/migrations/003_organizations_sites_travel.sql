-- ============================================================================
-- 003 — organizations, shared sites, and travel policy
--
-- Three shapes the old model could not hold:
--   1. A company with several physicians at one address (ExamWorks: D'Amico +
--      Pompan). practice_location duplicated the address per physician, which is
--      the Blair-notes-field mistake wearing a different hat.
--   2. A physician who will travel ANYWHERE. You cannot enumerate that as rows.
--   3. A physician who travels only within N miles, or only to a named list.
--
-- The move: a LOCATION IS A PLACE, not a property of a person.
--   site            = the place (address, coordinates, optionally owned by an org)
--   physician_site  = who practises there, and on what terms (office vs fly-in)
--   travel_policy   = the statements that cannot be enumerated as places
-- ============================================================================

CREATE TABLE organization (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL DEFAULT 'practice'
               CHECK (kind IN ('practice','group','ime_vendor','health_system','hospital','other')),
  website    TEXT,
  notes      TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A physical place. Owned by an org, or by nobody (an independent's own office).
CREATE TABLE site (
  id              INTEGER PRIMARY KEY,
  organization_id INTEGER REFERENCES organization(id) ON DELETE SET NULL,
  label           TEXT,
  address_line    TEXT,
  city            TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'CA',
  postal_code     TEXT,
  lat             REAL,
  lng             REAL,
  geocode_source  TEXT NOT NULL DEFAULT 'city_centroid'
                    CHECK (geocode_source IN ('city_centroid','zip_centroid','manual','geocoder','unknown')),
  is_active       INTEGER NOT NULL DEFAULT 1,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_site_org ON site(organization_id);
CREATE INDEX idx_site_geo ON site(lat, lng);

-- Who practises where, and on what terms. Confirmation lives here because the
-- claim being confirmed is "this physician will sit at this place" — not the
-- existence of the address.
CREATE TABLE physician_site (
  id                  INTEGER PRIMARY KEY,
  physician_id        INTEGER NOT NULL REFERENCES physician(id) ON DELETE CASCADE,
  site_id             INTEGER NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  site_type           TEXT NOT NULL DEFAULT 'office' CHECK (site_type IN ('office','flyin')),
  confirmation_status TEXT NOT NULL DEFAULT 'needs_confirm'
                        CHECK (confirmation_status IN ('confirmed','assumed','needs_confirm','out_of_state')),
  confirmed_by        TEXT,
  confirmed_at        TEXT,
  is_active           INTEGER NOT NULL DEFAULT 1,
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (physician_id, site_id)
);
CREATE INDEX idx_ps_physician ON physician_site(physician_id);
CREATE INDEX idx_ps_site      ON physician_site(site_id);

ALTER TABLE physician ADD COLUMN organization_id INTEGER REFERENCES organization(id) ON DELETE SET NULL;

-- The part you cannot express as rows.
--   none     — only their own offices count (the safe default)
--   listed   — offices plus the specific fly-in places recorded in physician_site
--   radius   — will travel up to radius_miles from any of their sites
--   anywhere — will go anywhere in the state
CREATE TABLE travel_policy (
  physician_id INTEGER PRIMARY KEY REFERENCES physician(id) ON DELETE CASCADE,
  mode         TEXT NOT NULL DEFAULT 'none' CHECK (mode IN ('none','listed','radius','anywhere')),
  radius_miles INTEGER,
  notes        TEXT,
  confirmed_by TEXT,
  confirmed_at TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------- data move
-- One site per distinct place. Matching is on ADDRESS, not on city+coordinates:
-- most rows are geocoded to a city centroid, so a coordinate match would merge
-- every unrelated practice in Fresno into a single fictional office. Rows
-- without an address stay distinct — an unknown place is not a shared place.
INSERT INTO site (label, address_line, city, state, postal_code, lat, lng, geocode_source, notes)
SELECT MIN(label), address_line, city, MIN(state), MIN(postal_code), MIN(lat), MIN(lng), MIN(geocode_source), NULL
FROM practice_location
GROUP BY city,
         CASE WHEN address_line IS NULL OR address_line = ''
              THEN 'unique:' || id            -- no address -> never merge
              ELSE LOWER(TRIM(address_line)) END;

INSERT INTO physician_site (physician_id, site_id, site_type, confirmation_status, confirmed_by, confirmed_at, is_active, notes, created_at)
SELECT pl.physician_id, s.id, pl.site_type, pl.confirmation_status, pl.confirmed_by, pl.confirmed_at, pl.is_active, pl.notes, pl.created_at
FROM practice_location pl
JOIN site s
  ON s.city = pl.city
 AND COALESCE(LOWER(TRIM(s.address_line)), '~') = COALESCE(LOWER(TRIM(pl.address_line)), '~')
 AND COALESCE(s.lat, -999) = COALESCE(pl.lat, -999)
ON CONFLICT (physician_id, site_id) DO NOTHING;

-- A physician with any fly-in site already has a 'listed' policy by definition.
INSERT INTO travel_policy (physician_id, mode)
SELECT DISTINCT physician_id, 'listed' FROM physician_site WHERE site_type = 'flyin'
ON CONFLICT (physician_id) DO NOTHING;

-- Views must go first: SQLite refuses to drop a table a view depends on.
DROP VIEW IF EXISTS v_provider_site;
DROP VIEW IF EXISTS v_unconfirmed_coverage;
DROP VIEW IF EXISTS v_physician_contact;

-- contact_method.location_id pointed at practice_location. A scheduling line
-- belongs to the PLACE, so it repoints at site.
CREATE TABLE contact_method_new (
  id                INTEGER PRIMARY KEY,
  physician_id      INTEGER NOT NULL REFERENCES physician(id) ON DELETE CASCADE,
  contact_person_id INTEGER REFERENCES contact_person(id) ON DELETE SET NULL,
  site_id           INTEGER REFERENCES site(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('email','phone','fax','website','portal')),
  purpose           TEXT NOT NULL DEFAULT 'general'
                      CHECK (purpose IN ('general','scheduling','billing','records','clinical','reports')),
  value             TEXT NOT NULL,
  value_normalized  TEXT,
  is_primary        INTEGER NOT NULL DEFAULT 0,
  is_active         INTEGER NOT NULL DEFAULT 1,
  verified_at       TEXT,
  verified_by       TEXT,
  notes             TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO contact_method_new (id,physician_id,contact_person_id,site_id,kind,purpose,value,value_normalized,is_primary,is_active,verified_at,verified_by,notes,created_at,updated_at)
  SELECT id,physician_id,contact_person_id,NULL,kind,purpose,value,value_normalized,is_primary,is_active,verified_at,verified_by,notes,created_at,updated_at FROM contact_method;
DROP TABLE contact_method;
ALTER TABLE contact_method_new RENAME TO contact_method;
CREATE INDEX idx_method_physician ON contact_method(physician_id, kind);
CREATE INDEX idx_method_norm      ON contact_method(value_normalized);

DROP TABLE practice_location;

-- ---------------------------------------------------------------- views
CREATE VIEW v_provider_site AS
SELECT ps.id AS physician_site_id, p.id AS physician_id, p.full_name, p.credentials, p.preference, p.is_qme,
       p.is_active AS physician_active, o.id AS organization_id, o.name AS organization_name,
       sp.code AS specialty_code, sp.is_core,
       s.id AS site_id, s.label, s.city, s.state, s.lat, s.lng, s.geocode_source,
       ps.site_type, ps.confirmation_status, ps.is_active AS link_active
FROM physician_site ps
JOIN physician p ON p.id = ps.physician_id
JOIN site s ON s.id = ps.site_id
LEFT JOIN organization o ON o.id = COALESCE(s.organization_id, p.organization_id)
LEFT JOIN specialty sp ON sp.id = p.primary_specialty_id;

-- Places with more than one physician: the reason `site` exists.
CREATE VIEW v_shared_site AS
SELECT s.id AS site_id, s.city, s.label, o.name AS organization_name,
       COUNT(DISTINCT ps.physician_id) AS physician_count,
       GROUP_CONCAT(DISTINCT p.full_name) AS physicians
FROM site s
JOIN physician_site ps ON ps.site_id = s.id AND ps.is_active = 1
JOIN physician p ON p.id = ps.physician_id AND p.is_active = 1
LEFT JOIN organization o ON o.id = s.organization_id
GROUP BY s.id HAVING physician_count > 1;

CREATE VIEW v_unconfirmed_coverage AS
SELECT p.id AS physician_id, p.full_name, p.phone, p.email, s.code AS specialty_code,
       COUNT(ps.id) AS location_count,
       SUM(CASE WHEN ps.confirmation_status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed_count
FROM physician p
LEFT JOIN specialty s ON s.id = p.primary_specialty_id
LEFT JOIN physician_site ps ON ps.physician_id = p.id AND ps.is_active = 1
WHERE p.is_active = 1
GROUP BY p.id
HAVING location_count = 0 OR confirmed_count < location_count;

CREATE VIEW v_physician_contact AS
SELECT p.id AS physician_id, p.full_name, cm.kind, cm.purpose, cm.value, cm.value_normalized,
       cm.is_primary, cp.name AS person_name, cp.role AS person_role, s.city AS site_city
FROM physician p
JOIN contact_method cm ON cm.physician_id = p.id AND cm.is_active = 1
LEFT JOIN contact_person cp ON cp.id = cm.contact_person_id
LEFT JOIN site s ON s.id = cm.site_id;
