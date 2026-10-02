export const RELEASE_LIMIT = 20

export function recentReleases(releases = []) {
  return releases.toSorted((a, b) => b.version - a.version).slice(0, RELEASE_LIMIT)
}
