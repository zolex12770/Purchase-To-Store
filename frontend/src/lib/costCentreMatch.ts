/**
 * Department → Cost Centre auto-match (Purchase Indent header).
 *
 * Real master data is messy by nature (e.g. both "Admin Cost Centre" and
 * "Admin Department" exist for Department "Administration"; casing and
 * punctuation are inconsistent — "power press cost centre" vs "Power Press
 * Department"). This is a token-overlap scorer over the ACTUAL synced Cost
 * Centre list, not a hardcoded name map — it never invents a Cost Centre that
 * doesn't exist, and returns `null` when nothing scores above a confidence
 * floor rather than guessing.
 */
export interface MatchOption {
  value: number;
  label: string;
}

const STOPWORDS = new Set(['and', 'the', 'of', 'for']);

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s: string): string[] {
  return normalize(s)
    .split(' ')
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Coverage required before a match is trusted: the fraction of the
 * department's own tokens that found some match (exact = full credit, a
 * stem/abbreviation match = half credit), out of every department token.
 * 0.5 means, e.g., a single-token department like "Administration" is
 * trusted on a stem match alone ("admin" vs "administration"), while a
 * multi-token department needs proportionally broader coverage — a single
 * coincidental partial match on one word of a three-word department is not
 * enough to trust.
 */
const MIN_COVERAGE = 0.5;

/**
 * Returns the best-matching Cost Centre id for a Department label, or `null`
 * if no candidate clears the confidence floor.
 */
export function matchCostCentre(departmentLabel: string, costCentres: MatchOption[]): number | null {
  if (!departmentLabel || costCentres.length === 0) return null;

  const deptNorm = normalize(departmentLabel);
  const deptTokens = tokens(departmentLabel);
  if (deptTokens.length === 0) return null;

  let best: { value: number; coverage: number; isCostCentreNamed: boolean } | null = null;

  for (const cc of costCentres) {
    const ccNorm = normalize(cc.label);
    if (ccNorm === deptNorm) return cc.value; // exact match — strongest possible signal

    const ccTokens = tokens(cc.label);
    let credit = 0;
    for (const dt of deptTokens) {
      if (ccTokens.includes(dt)) {
        credit += 1; // exact token match, e.g. "purchase" in "Purchase Department"
      } else if (ccTokens.some((ct) => ct.length > 3 && dt.length > 3 && (ct.startsWith(dt) || dt.startsWith(ct)))) {
        credit += 0.5; // stem/abbreviation match, e.g. "admin" vs "administration"
      }
    }
    const coverage = credit / deptTokens.length;
    if (coverage < MIN_COVERAGE) continue;

    // A field literally called "Cost Centre" should prefer a candidate that is
    // itself named as a cost centre over a same-coverage "...Department" one —
    // this is a general tie-break, not specific to any one department name.
    const isCostCentreNamed = ccNorm.includes('cost centre') || ccNorm.includes('cost center');

    if (
      !best ||
      coverage > best.coverage ||
      (coverage === best.coverage && isCostCentreNamed && !best.isCostCentreNamed)
    ) {
      best = { value: cc.value, coverage, isCostCentreNamed };
    }
  }

  return best ? best.value : null;
}
