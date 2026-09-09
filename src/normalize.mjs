// Canonicalisation for contact values. Two rules:
//   1. The original is never destroyed — `value` keeps what was typed.
//   2. `value_normalized` is what you match, dedupe and search on.

/** '(650) 410-0078 ' | '+1 805 888 1018' | '818-806-8830 x 1' -> '+16504100078' */
export function normalizePhone(raw) {
  if (!raw) return null;
  // Strip an extension first: '818-806-8830 x 1' must not become '+18188068830 1'.
  const base = String(raw).replace(/\s*(?:x|ext\.?|extension)\s*\d+\s*$/i, '');
  const d = base.replace(/[^\d]/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  if (d.length > 11) return null;         // almost certainly two numbers mashed together
  if (d.length >= 7) return '+1' + d;
  return null;
}

/**
 * One field, several numbers, sometimes labelled:
 *   '(office) 805.962.6222 (cell)    805. 252.6286'
 *   '818-806-8830 x 1'
 */
export function parsePhones(raw) {
  if (!raw) return [];
  const s = String(raw);
  const re = /(?:\((office|cell|mobile|fax|direct|scheduling)\)\s*)?((?:\+?\d[\d\s().\-]{6,}\d))(?:\s*(?:x|ext\.?|extension)\s*(\d+))?/gi;
  const out = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    const [, label, num, ext] = m;
    if (num.replace(/\D/g, '').length < 7) continue;
    const value = (num.trim() + (ext ? ' x' + ext : '')).replace(/\s+/g, ' ');
    out.push({
      value,
      normalized: normalizePhone(num),
      kind: label && label.toLowerCase() === 'fax' ? 'fax' : 'phone',
      purpose: label && /schedul/i.test(label) ? 'scheduling' : 'general',
      label: label ? label.toLowerCase() : null,
    });
  }
  return out;
}
export const normalizeEmail = (raw) => (raw ? String(raw).trim().toLowerCase() || null : null);

/** 'drsanchezphd.com' -> 'https://drsanchezphd.com' */
export function normalizeUrl(raw) {
  if (!raw) return null;
  let v = String(raw).trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  try { const u = new URL(v); return u.origin.toLowerCase() + (u.pathname === '/' ? '' : u.pathname); }
  catch { return v.toLowerCase(); }
}
export function normalizeValue(kind, raw) {
  if (kind === 'phone' || kind === 'fax') return normalizePhone(raw);
  if (kind === 'email') return normalizeEmail(raw);
  if (kind === 'website' || kind === 'portal') return normalizeUrl(raw);
  return raw ? String(raw).trim().toLowerCase() : null;
}

/** 'expert@x.com / y@z.com' -> ['expert@x.com','y@z.com'] */
export const splitMulti = (raw) =>
  !raw ? [] : String(raw).split(/[;,/]|\s+\band\b\s+/i).map(s => s.trim()).filter(Boolean);

/**
 * 'Lou Lor - Case Manager'      -> [{name:'Lou Lor', role:'Case Manager'}]
 * 'Maryn Hart (Office Manager)' -> [{name:'Maryn Hart', role:'Office Manager'}]
 * 'Benjamin/Grave Busfield'     -> [{name:'Benjamin Busfield'},{name:'Grave Busfield'}]
 * 'Ms. Lou Lor'                 -> [{name:'Lou Lor'}]   (honorific stripped so it matches)
 */
export function parseContactPeople(raw) {
  if (!raw) return [];
  const s = String(raw).trim();
  if (!s || s === '—' || s.toLowerCase() === 'nan') return [];

  // "First1/First2 Surname" — shared surname across a slash
  const shared = s.match(/^([A-Za-z]+)\/([A-Za-z]+)\s+([A-Za-z'-]+)$/);
  if (shared) return [{ name: `${shared[1]} ${shared[3]}` }, { name: `${shared[2]} ${shared[3]}` }];

  return s.split(/\s*[;/]\s*|\s+&\s+/).map(part => {
    let p = part.trim(), role = null;
    const paren = p.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (paren) { p = paren[1].trim(); role = paren[2].trim(); }
    const dash = p.match(/^(.*?)\s+[-–—]\s+(.+)$/);
    if (dash) { p = dash[1].trim(); role = dash[2].trim(); }
    const comma = p.match(/^(.*?),\s*(MD|DO|PhD|PsyD|RN|MFT|Case Manager|Office Manager)\.?$/i);
    if (comma) { p = comma[1].trim(); role = role || comma[2].trim(); }
    p = p.replace(/^(Mr|Mrs|Ms|Miss|Dr)\.?\s+/i, '').trim();   // honorifics break matching
    return p ? { name: p, role } : null;
  }).filter(Boolean);
}
/** Match key so 'Ms. Lou Lor' and 'Lou Lor - Case Manager' collapse to one person. */
export const personKey = (name) => String(name).toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * The export puts the company in the name field:
 *   'Donald C. Pompan, M.D. - ExamWorks'          -> person + ExamWorks
 *   'Dr. Monica Robinson / Sacramento Eye Consultants'
 *   'Roseville Cardiology'                        -> the record IS an organization
 */
const ORG_KIND = [
  [/\b(examworks|evaluations?|ime|medical[- ]legal)\b/i, 'ime_vendor'],
  [/\b(hospital|district hospital|medical cent(er|re))\b/i, 'hospital'],
  [/\b(health system|kaiser)\b/i, 'health_system'],
  [/\b(group|associates|consultants|p\.?c\.?|medical corporation|inc\.?)\b/i, 'group'],
];
const CRED = /\b(M\.?D|D\.?O|Ph\.?D|Psy\.?D|D\.?P\.?M|O\.?D|MFT|DLFAPA|PT|DPT|MPH|ABPP|QME|HSPP|MSC|LAADC|CSCS|OCS|ABDA)\b/i;

export function parseOrganization(rawName) {
  const s = String(rawName || '').trim();
  const kindOf = (n) => (ORG_KIND.find(([re]) => re.test(n)) || [null, 'practice'])[1];

  // 'Person, MD - Org'  or  'Person, OD / Org'
  const split = s.match(/^(.*?)\s+[-–—/]\s+(.+)$/);
  if (split) {
    const [, left, right] = split;
    if (CRED.test(left) || /^(Dr|Ms|Mr|Mrs)\.?\s/i.test(left))
      return { person: left.trim(), organization: right.trim(), kind: kindOf(right), isOrgRecord: false };
  }
  // No credential anywhere -> the record is the organization itself
  if (!CRED.test(s)) return { person: s, organization: s, kind: kindOf(s), isOrgRecord: true };
  return { person: s, organization: null, kind: null, isOrgRecord: false };
}
