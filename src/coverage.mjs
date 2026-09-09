import { driveTo, isNoLimit, NO_LIMIT } from './geo.mjs';

/**
 * The gap engine. Derived on every call — never cached, never stored.
 *
 * A (region x specialty) cell is COVERED when at least one active location
 * belonging to an active physician of that specialty sits within the region's
 * effective proximity limit of the region pin.
 */
export function computeCoverage(db, { specialties = null } = {}) {
  const regions = db.prepare('SELECT * FROM region ORDER BY sort_order').all();
  const specs = db.prepare('SELECT * FROM specialty ORDER BY sort_order').all();
  const active = specialties ? specs.filter(s => specialties.includes(s.code)) : specs.filter(s => s.is_core);

  const globalStd = parseInt(
    db.prepare("SELECT value FROM setting WHERE key='standard_minutes'").get()?.value ?? '60', 10);
  const overrides = Object.fromEntries(
    db.prepare('SELECT region_id, minutes FROM region_radius_override').all().map(r => [r.region_id, r.minutes]));
  const targets = {};
  for (const t of db.prepare('SELECT * FROM coverage_target').all())
    targets[`${t.region_id}|${t.specialty_id}`] = t.target_count;

  // Sites a physician actually sits at.
  const sites = db.prepare(`
    SELECT ps.id AS link_id, ps.physician_id, s.city, s.lat, s.lng,
           ps.site_type, ps.confirmation_status, p.full_name, p.is_qme,
           p.primary_specialty_id AS specialty_id, s.id AS site_id,
           o.name AS organization_name
    FROM physician_site ps
    JOIN site s ON s.id = ps.site_id
    JOIN physician p ON p.id = ps.physician_id
    LEFT JOIN organization o ON o.id = COALESCE(s.organization_id, p.organization_id)
    WHERE ps.is_active = 1 AND s.is_active = 1 AND p.is_active = 1 AND p.performs_ime = 1
      AND s.lat IS NOT NULL`).all();

  // The statements that cannot be enumerated as places.
  const travel = Object.fromEntries(
    db.prepare('SELECT * FROM travel_policy').all().map(t => [t.physician_id, t]));

  const limitFor = (r) => overrides[r.id] ?? globalStd;
  const cells = [];

  for (const r of regions) {
    const limit = limitFor(r);
    for (const s of active) {
      // Nearest site per physician, then decide reachability. A physician
      // reaches a pin if a site is inside the limit, OR their travel policy
      // says they will come regardless of the drive.
      const byPhys = new Map();
      for (const site of sites) {
        if (site.specialty_id !== s.id) continue;
        const d = driveTo(site.lat, site.lng, r);
        if (!d) continue;
        const prev = byPhys.get(site.physician_id);
        if (!prev || d.minutes < prev.minutes) {
          byPhys.set(site.physician_id, {
            physician_id: site.physician_id, full_name: site.full_name, is_qme: !!site.is_qme,
            city: site.city, site_id: site.site_id, site_type: site.site_type,
            organization_name: site.organization_name,
            confirmation_status: site.confirmation_status, ...d,
          });
        }
      }
      const hits = [...byPhys.values()].map(h => {
        const tp = travel[h.physician_id];
        const mode = tp ? tp.mode : 'none';
        if (h.minutes <= limit) return { ...h, reach: 'in_range' };
        // Beyond the limit — does a policy carry them anyway?
        if (mode === 'anywhere') return { ...h, reach: 'travels_anywhere' };
        if (mode === 'radius' && tp.radius_miles != null && h.miles <= tp.radius_miles)
          return { ...h, reach: 'within_travel_radius' };
        return null;   // 'listed' is already expressed by the fly-in sites themselves
      }).filter(Boolean).sort((a, b) => a.minutes - b.minutes);
      const target = targets[`${r.id}|${s.id}`] ?? 1;
      cells.push({
        region_id: r.id, region: r.name, pin: r.pin_label,
        population_m: r.population_m, is_flyin_corridor: !!r.is_flyin_corridor,
        specialty_id: s.id, specialty: s.code,
        limit_minutes: limit, unlimited: isNoLimit(limit),
        count: hits.length, target,
        short: Math.max(0, target - hits.length),
        nearest_minutes: hits.length ? hits[0].minutes : null,
        within_30: hits.some(h => h.minutes <= 30),
        all_flyin: hits.length > 0 && hits.every(h => h.site_type === 'flyin' || h.reach !== 'in_range'),
        by_travel: hits.filter(h => h.reach !== 'in_range').length,
        any_confirmed: hits.some(h => h.confirmation_status === 'confirmed'),
        providers: hits,
      });
    }
  }

  const gapCells = cells.filter(c => c.count === 0);
  const summary = {
    standard_minutes: globalStd,
    specialties: active.map(s => s.code),
    cells_total: cells.length,
    cells_covered: cells.filter(c => c.count > 0).length,
    metro_gaps: gapCells.filter(c => !c.is_flyin_corridor).length,
    corridor_gaps: gapCells.filter(c => c.is_flyin_corridor).length,
    below_target: cells.filter(c => c.short > 0).length,
    within_30: cells.filter(c => c.within_30).length,
    flyin_only: cells.filter(c => c.all_flyin).length,
    no_backup: cells.filter(c => c.count === 1).length,
    population_gapped_m: +[...new Set(gapCells.filter(c => !c.is_flyin_corridor).map(c => c.region_id))]
      .reduce((a, id) => a + (regions.find(r => r.id === id)?.population_m || 0), 0).toFixed(2),
  };
  return { summary, cells };
}

/** Ranked provider list for an arbitrary point — the scheduler's question. */
export function providersNear(db, lat, lng, region, { specialties = null, limit = null } = {}) {
  const rows = db.prepare(`
    SELECT s.id AS site_id, s.city, s.lat, s.lng, ps.site_type, ps.confirmation_status,
           p.id AS physician_id, p.full_name, p.phone, p.email, p.is_qme, p.preference,
           sp.code AS specialty, o.name AS organization_name
    FROM physician_site ps
    JOIN site s ON s.id = ps.site_id
    JOIN physician p ON p.id = ps.physician_id
    LEFT JOIN specialty sp ON sp.id = p.primary_specialty_id
    LEFT JOIN organization o ON o.id = COALESCE(s.organization_id, p.organization_id)
    WHERE ps.is_active = 1 AND s.is_active = 1 AND p.is_active = 1 AND s.lat IS NOT NULL`).all();

  const byPhys = new Map();
  for (const r of rows) {
    if (specialties && !specialties.includes(r.specialty)) continue;
    const d = driveTo(lat, lng, { pin_lat: region.pin_lat, pin_lng: region.pin_lng, effective_mph: region.effective_mph });
    // measure to the point itself, not the pin
    const dd = driveTo(r.lat, r.lng, { pin_lat: lat, pin_lng: lng, effective_mph: region.effective_mph });
    const prev = byPhys.get(r.physician_id);
    if (!prev || dd.minutes < prev.minutes) byPhys.set(r.physician_id, { ...r, ...dd });
  }
  let out = [...byPhys.values()].sort((a, b) => a.minutes - b.minutes);
  if (limit && !isNoLimit(limit)) out = out.filter(o => o.minutes <= limit);
  return out;
}
