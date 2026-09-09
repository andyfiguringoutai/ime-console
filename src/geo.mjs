// Distance + drive-time estimation. Deliberately isolated so it can be swapped
// for a routing API (Google/Mapbox distance matrix) without touching anything else.
export const ROAD_FACTOR = 1.27;   // straight-line -> road distance
export const DEFAULT_MPH = 48;
export const NO_LIMIT = 9999;      // sentinel: proximity ignored

export function haversineMiles(la1, lo1, la2, lo2) {
  const R = 3958.8, r = Math.PI / 180;
  const dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Estimated door-to-door drive from a point to a region pin. */
export function driveTo(lat, lng, region) {
  if (lat == null || lng == null) return null;
  const miles = haversineMiles(lat, lng, region.pin_lat, region.pin_lng) * ROAD_FACTOR;
  const mph = region.effective_mph || DEFAULT_MPH;
  return { miles: Math.round(miles), minutes: Math.round((miles / mph) * 60) };
}

export function isNoLimit(v) { return v >= NO_LIMIT; }

/** Radius in straight-line miles that a minute budget buys in a given region. */
export function radiusMiles(region, minutes) {
  return (minutes * (region.effective_mph || DEFAULT_MPH)) / 60 / ROAD_FACTOR;
}

/** Which catchment does an arbitrary point fall in? Nearest pin wins. */
export function nearestRegion(lat, lng, regions) {
  let best = null;
  for (const r of regions) {
    const d = haversineMiles(lat, lng, r.pin_lat, r.pin_lng);
    if (!best || d < best.d) best = { region: r, d };
  }
  return best && best.region;
}
