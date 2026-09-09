# IME Network — provider management & coverage assessment

A working system for managing the California IME provider network and measuring
coverage against drive-time targets. Built to be **absorbed into your main system**:
the schema and API contract are the durable artifacts, the UI is replaceable.

```bash
npm install
npm run seed      # builds data/ime-network.db from the bundled export
npm start         # http://localhost:3000
npm test          # 63 assertions: engine, CRUD, workflow, contacts, docs, orgs, travel, UI render
npm run migrate   # apply any new db/migrations/*.sql
npm run import -- <file.xlsx> [--dry-run]   # refresh from a new export
```

---

## The one idea that matters

**Coverage is derived, never stored.**

There is no `coverage` table. `GET /api/coverage` recomputes from
`practice_location` + `region` + `coverage_target` on every call. This is
deliberate: a stored coverage figure drifts from the data behind it, and a
coverage map you can't trust is worse than none — you'll sell against it.

Everything else follows from that. If you port one thing, port this.

---

## The interface

Two jobs, two shapes.

**Ledger and Map** answer *where are we thin?* — planning. Regions run north to
south; the map measures drive time to a pin.

**Providers** answers *I'm about to call this person* — operations. You reach it
from the map: click any provider dot, or any name in *who reaches this pin*, and
you land on their record. It's master/detail: the list stays on the left because you work a list, and a
full-page record loses your place on every provider. The record opens with a
**coverage claim** strip stating in one sentence what you can actually stand
behind — *"3 sites, none confirmed — inferred from the source export, never
verified"* — because that is the whole point of the system, and it belongs above
the phone number, not buried in a badge.

Layout follows the loop: **where they sit** and **who to call** sit side by side,
because confirming coverage means ringing someone about a location.
**Correspondence** sits directly beneath the locations, so you log what you
learned right under the thing you're changing. Documents and fees are reference,
so they're the right-hand column.

Phone numbers are `tel:` links built from the normalized E.164 value, so clicking
one dials the right number even when the stored text reads `(office) 805.962.6222`.

---

## Data model

### `practice_location` — the central table
A physician is not *in* a region. A **location** is a point, and coverage is a
function of distance from that point to a region's pin. This is the table the
old spreadsheet lacked, and its absence was the source of every wrong answer:
Blair's three Sacramento sites lived in a free-text `Notes` field, and Dillin's
ten cities were invisible.

Two columns carry most of the business meaning:

| column | why it exists |
|---|---|
| `site_type` | `office` = standing space. `flyin` = they travel and you rent space. This *is* the business model; it needs to be a column, not a footnote. |
| `confirmation_status` | Provenance of the coverage claim, held **per location** rather than per physician. `assumed` means someone inferred it from an address. `confirmed` means a human asked. Most of the seed is `assumed` — that distinction is the difference between a map you can sell and one you hope is right. |

`geocode_source` records how coordinates were obtained (`city_centroid`,
`zip_centroid`, `manual`, `geocoder`). It tells you how much to trust a drive
time. Today most rows are `city_centroid` — fine for a metro, poor for a rural
ZIP that spans 40 miles.

### `region` — a catchment, not a census area
Each region has a **pin** at its commercial heart and an `effective_mph` that
encodes congestion (30 in the LA Basin, 48 in open country). A 60-minute radius
is therefore ~24 miles around Downtown LA and ~38 around Bishop. `is_flyin_corridor`
marks the eleven regions where recruiting is unrealistic — a gap there is a travel
assignment, not a failure, and the summary counts them separately.

### `organization` / `site` / `physician_site` — a location is a place
The export hid three shapes the first model couldn't hold:

- **A company with several physicians.** 12 records carry the firm in the name
  field (`Donald C. Pompan, M.D. - ExamWorks`); six records *are* organizations
  (`Roseville Cardiology`). `organization` now exists, with a `kind` —
  `ime_vendor`, `hospital`, `group`, `practice`.
- **Two physicians at one address.** Jagdev Singh and Lowe Audiology share
  6101 N Fresno St. Under the old model that was two copies of an address, which
  is the Blair-notes-field mistake wearing a different hat. Now `site` is the
  place and `physician_site` says who sits there and on what terms.
- **Sites are matched on ADDRESS, never on city+coordinates.** Most rows geocode
  to a city centroid, so a coordinate match fused all eleven unrelated Fresno
  practices into one fictional office. A place with no address is its own place.

Editing an address updates the `site`, so it fixes for everyone who sits there;
`site_physician_count` warns you when that's more than one person.

### `travel_policy` — the part you cannot enumerate as rows
"Will travel anywhere" is not a list of places.

| mode | meaning |
|---|---|
| `none` | Only their own offices count. **The default** — the conservative answer until someone asks. |
| `listed` | Offices plus the specific fly-in places in `physician_site`. |
| `radius` | Will travel `radius_miles` from any of their sites. |
| `anywhere` | Reaches every pin in the state, however far. |

The coverage engine applies this after the drive-time test: a physician outside
the limit still reaches a pin if their policy carries them, and each hit reports
`reach` as `in_range`, `within_travel_radius` or `travels_anywhere`. Cells reached
only by travel are flagged, because that is a rented room, not a standing office.

### `contact_person` / `contact_method` — because the export couldn't hold it
The source file proved the flat columns were wrong:

| in the spreadsheet | what it actually was |
|---|---|
| `expert@diabloortho.com / busfieldmd@gmail.com` | two emails in one cell |
| `Benjamin/Grave Busfield` | two people in one cell |
| `Lou Lor - Case Manager` and `Ms. Lou Lor` | one person, two spellings, two practices |
| `(office) 805.962.6222 (cell) 805. 252.6286` | two numbers, one cell — the second was invisible |
| `818-806-8830 x 1` | an extension that naive digit-stripping turns into a foreign number |

`contact_person` holds named humans with roles. `contact_method` holds every way
to reach someone, attachable to the practice, a person, or a single office
(scheduling lines are usually per-site). Two columns matter: `value` keeps
exactly what was typed and is never destroyed; `value_normalized` is the E.164 /
lowercased / canonical-URL form you match, dedupe and search on. All 78 phones in
the network now normalize; before parsing, two did not.

`src/normalize.mjs` is the only place this logic lives.

### `correspondence` — the interaction log
Direction, channel, subject, body, who logged it, when it happened. The useful
column is `outreach_id`: a logged call points at the call-sheet item it served,
so the task and the record of doing it are one story. Attachments link to
`document` rows.

### `document` — real files, versioned
`POST` is multipart; bytes land under `data/documents/{physician_id}/`. Each file
gets a `sha256` — re-uploading identical bytes under the same `doc_type` dedupes
rather than duplicating (scoped by type on purpose: one PDF can legitimately be
both a CV and a report sample). A new CV supersedes the old one: `version` bumps,
`supersedes_id` chains back, `is_current` flips. Types include `fee_schedule`,
`w9`, `insurance` and `licensure`; `fee.document_id` lets a rate point at the PDF
it came from. `expires_on` + the `v_expiring_documents` view make lapsing
credentials a queue rather than a surprise.

Storage is disk today. `storage_path` is the only thing the schema knows, so
moving to S3 means changing `src/routes/documents.mjs` and nothing else.

### `outreach` — the call sheet as a real queue
Seeded with the 15 records whose coverage can't be established from the file,
each carrying a `prompt` saying what to actually ask. Not a derived list: it has
`assigned_to`, `status`, `priority`, `outcome_note`, so two people can work it.
The Call sheet tab reads and writes this table directly — assign an item, type
what the provider said, resolve it, and the outcome is stamped with who and when
and visible to everyone else immediately.

### `audit_log` — append-only provenance
Every mutation writes `before_json`/`after_json` plus an actor taken from the
`x-actor` header. Confirming a location stamps `confirmed_by` / `confirmed_at`.

### Soft deletes
`DELETE /api/physicians/:id` sets `is_active = 0`. Coverage drops them
immediately; history survives. Locations hard-delete (they're cheap to re-add).

---

## API

| method | path | notes |
|---|---|---|
| GET | `/api/health` | schema version |
| GET | `/api/specialties` | `is_core` flags the four that drive the maths |
| GET/PUT | `/api/settings[/:key]` | `standard_minutes` (9999 = no limit), `data_as_of` |
| GET | `/api/regions` | includes `radius_override` |
| PATCH | `/api/regions/:id` | move a pin, change `effective_mph`, toggle corridor |
| PUT | `/api/regions/:id/radius` | `{minutes}` or `{minutes:null}` to clear |
| GET/PUT | `/api/targets` | `{all:2}` sets depth everywhere |
| GET/POST | `/api/physicians` | `?q=&specialty=&confirmation=` |
| GET/PATCH/DELETE | `/api/physicians/:id` | DELETE is soft |
| POST | `/api/physicians/:id/locations` | geocodes a bare city or 5-digit ZIP |
| PATCH/DELETE | `/api/locations/:id` | confirming stamps who/when |
| GET/POST | `/api/physicians/:id/fees` | money in integer cents, never float |
| GET | `/api/physicians/:id/contacts` | people + methods, grouped |
| POST | `/api/physicians/:id/contacts/people` | named humans with roles |
| POST | `/api/physicians/:id/contacts/methods` | a pasted multi-number field splits into rows |
| PATCH/DELETE | `/api/contacts/methods/:id` | `{verified:true}` stamps who/when |
| GET | `/api/contacts/search?q=` | matches however the number was typed |
| GET/POST | `/api/physicians/:id/correspondence` | the thread; links to the outreach item it served |
| GET | `/api/correspondence?limit=` | network-wide activity feed |
| GET/POST | `/api/physicians/:id/documents` | POST is `multipart/form-data`, field name `file` |
| GET | `/api/documents/:id/file` | streams the bytes; `?download=1` to attach |
| PATCH/DELETE | `/api/documents/:id` | delete removes the row **and** the bytes |
| GET | `/api/documents/expiring?days=90` | lapsing credentials as a queue |
| GET | `/api/coverage` | `?specialties=PSYCH,ORTHO` — summary + every cell |
| GET | `/api/gaps` | gaps ranked by population, split metro vs corridor |
| GET | `/api/lookup` | `?q=93301&specialties=CARDIO&limit=60` — the scheduler's question |
| GET/POST/PATCH | `/api/outreach` | the call sheet |
| GET | `/api/audit` | `?entity=physician&limit=100` |

All mutations accept `x-actor: <name>`. There is **no authentication** — see below.

---

## Estimation, and what it isn't

`src/geo.mjs` is the only place distance is computed. Drive time is
straight-line × 1.27 for road routing ÷ `effective_mph`. It does not know about
rush hour, the Grapevine, or which side of town someone lives on.

It is **isolated on purpose**. Swapping in a Google/Mapbox distance matrix means
replacing `driveTo()` and nothing else. Until then, treat anything within a few
minutes of a threshold as a judgment call — Fresno→Visalia is 62 minutes and
fails an hour standard by a rounding error.

Validation: the engine independently reproduces the static build exactly —
39/104 covered, 26 metro gaps, 39 corridor gaps, 25 cells one-deep, 31.9M in a
gapped metro. Two implementations agreeing is the reason to believe either.

---

## Porting to Postgres

The schema is deliberately boring. To move it:

- `INTEGER PRIMARY KEY` → `GENERATED ALWAYS AS IDENTITY`
- `datetime('now')` → `now()`
- `TEXT` timestamps → `timestamptz`
- `INTEGER` booleans → `boolean`
- `CHECK (x IN (...))` → keep, or promote to enums / lookup tables
- Partial index on `document(expires_on)` works as-is
- Add `PostGIS` and `practice_location.geog` if you want real spatial queries;
  `computeCoverage` becomes a query rather than a loop

`source_id` on `physician` preserves the id from the originating directory, so a
re-import can match rather than duplicate.

---

## Refreshing from a new export

```bash
npm run import -- data/FFD_Provider_Directory_Export.xlsx --dry-run   # preview
npm run import -- data/FFD_Provider_Directory_Export.xlsx --actor "Andy"
```

Matches on `physician.source_id`, so re-running is safe — existing records update
in place, new ones insert, nothing duplicates. Verified idempotent: a second run
of the same file reports `0 inserted, 0 updated`.

Two behaviours worth knowing:

- **The export carries one row per physician-location.** Chhaya Makhija appears
  twice (Fresno, Lafayette) under two IDs; this database carries one physician
  with many sites. When a `source_id` is unknown the importer falls back to a
  full-name match, so a second office is added as a *site* rather than a
  duplicate person. Matching is on the whole name, so `Catherine J. Ward` and
  `Nicole K. Ward` stay distinct.
- **Nothing is ever deleted.** A provider present in the database but absent from
  a fresh export is *reported*, not removed — an export can be filtered, and a
  deletion is not recoverable.

Addresses geocode by ZIP first (unambiguous), then city name. Anything that
can't be placed is inserted anyway and pushed onto the call sheet, so an
unplaceable provider is a phone call rather than a silent hole.

## Authentication & hosting

The app now requires a login. Anonymous browsers get a sign-in page; the API
returns 401 without a valid session. Sessions are server-side (the cookie holds
only an opaque token), passwords are bcrypt-hashed, and the audit trail records
the real logged-in user rather than a typed name.

```bash
npm run create-admin -- you@occu-med.com "Your Name"   # first login (prints a temp password)
```

Admins add teammates from the account menu in the app. To put it online, see
**DEPLOY.md** — it walks through Fly.io or Render, both about $5–10/month, with a
persistent volume so data survives redeploys. `docker-compose up` runs it locally
in a container if you want to test that first.

## What this is not

- **Single-writer database.** SQLite in WAL mode is fine for a small team; it is
  not a concurrency story for dozens of simultaneous editors.
- **Migrations exist now** (`db/migrations/*.sql`, `npm run migrate`), applied in
  filename order and recorded in `schema_migrations`. `schema.sql` is retained
  only as a readable snapshot of v1 — **migrations are the source of truth**.
- **Single-writer assumptions.** SQLite in WAL mode is fine for a small team; it
  is not a concurrency story for dozens of users.

## Known data gaps (unchanged by this build)

15 providers can't be placed from the source file. 5 have no address at all —
Sharma (neurology) is the valuable one. Hoffman holds a QME, which is a
California credential, so his availability here is worth a call. Most of the
network reads `assumed`, not `confirmed`. The call sheet is the shortest path
from "map we hope is right" to "map we can sell".
