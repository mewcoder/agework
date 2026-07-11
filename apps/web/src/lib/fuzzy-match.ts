/**
 * Fuzzy matching for file paths (fzf-style subsequence matching with scoring).
 *
 * - Query chars must appear in order (subsequence) to match.
 * - Consecutive matches, path-boundary matches, and filename matches get bonuses.
 * - Gaps get penalties. Shorter paths preferred at equal score.
 * - Returns top `limit` results sorted by score descending.
 *
 * @example
 * fuzzyMatch("login", ["src/auth/login.tsx", "src/utils/helpers.ts"])
 * // → ["src/auth/login.tsx"]
 */

export type FuzzyMatchResult = {
  path: string;
  filename: string;
  dir: string;
  score: number;
};

const BOUNDARY_CHARS = new Set(["/", "-", "_", "."]);

/**
 * Returns true if the character at `i - 1` in `s` is a path boundary
 * (slash, hyphen, underscore, dot) or if `i` is 0 (start of string).
 */
function isBoundary(s: string, i: number): boolean {
  if (i === 0) return true;
  return BOUNDARY_CHARS.has(s[i - 1]!);
}

/**
 * Score a query against a target string (both lowercased).
 * Returns null if the query is not a subsequence of the target.
 */
function scoreFuzzy(
  lowerQuery: string,
  lowerTarget: string,
  _originalTarget: string,
): number | null {
  if (lowerQuery.length === 0) return 0;

  let qi = 0;
  let score = 0;
  let consecutive = 0;
  let lastMatchIdx = -2;
  const lastSlash = lowerTarget.lastIndexOf("/");

  for (let ti = 0; ti < lowerTarget.length && qi < lowerQuery.length; ti++) {
    if (lowerTarget[ti] === lowerQuery[qi]) {
      // Consecutive match bonus
      if (lastMatchIdx === ti - 1) {
        consecutive++;
        score += 8 + consecutive * 4;
      } else {
        consecutive = 0;
        score += 4;
      }

      // Path boundary bonus
      if (isBoundary(lowerTarget, ti)) {
        score += 10;
      }

      // Filename bonus (match in the part after last /)
      if (ti > lastSlash) {
        score += 6;
      }

      lastMatchIdx = ti;
      qi++;
    } else if (qi > 0) {
      // Gap penalty — reset consecutive
      consecutive = 0;
    }
  }

  if (qi < lowerQuery.length) return null;

  // Slight preference for shorter paths (fewer gaps)
  score -= Math.floor(lowerTarget.length / 100);

  return score;
}

/**
 * Fuzzy match a query against a list of file paths.
 * Returns the top `limit` paths sorted by score (best first).
 */
export function fuzzyMatch(
  query: string,
  paths: readonly string[],
  limit = 20,
): FuzzyMatchResult[] {
  if (!query) {
    return paths.slice(0, limit).map((path) => {
      const lastSlash = path.lastIndexOf("/");
      return {
        path,
        filename: lastSlash >= 0 ? path.slice(lastSlash + 1) : path,
        dir: lastSlash >= 0 ? path.slice(0, lastSlash + 1) : "",
        score: 0,
      };
    });
  }

  const lowerQuery = query.toLowerCase();
  const results: FuzzyMatchResult[] = [];

  for (const path of paths) {
    const lowerPath = path.toLowerCase();
    const score = scoreFuzzy(lowerQuery, lowerPath, path);
    if (score !== null) {
      const lastSlash = path.lastIndexOf("/");
      results.push({
        path,
        filename: lastSlash >= 0 ? path.slice(lastSlash + 1) : path,
        dir: lastSlash >= 0 ? path.slice(0, lastSlash + 1) : "",
        score,
      });
    }
  }

  // Sort by score descending, then by path length ascending (shorter = better)
  results.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return results.slice(0, limit);
}
