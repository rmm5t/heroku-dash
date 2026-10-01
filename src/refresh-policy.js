const OPERATIONAL_SECTIONS = ['app', 'formation', 'dynos', 'releases']
const METADATA_SECTIONS = ['coupling', 'addons', 'attachments', 'domains', 'buildpacks']
const METADATA_INTERVAL = 5 * 60_000

export function autoRefreshSections(data, now = Date.now()) {
  return [...OPERATIONAL_SECTIONS, ...METADATA_SECTIONS.filter(section => data.errors[section]
    || !Number.isFinite(data.sectionFetchedAt?.[section]) || now - data.sectionFetchedAt[section] >= METADATA_INTERVAL)]
}

// Background reads share cooldowns, but successful reads only reset their own
// failure streak. A healthy Platform API must not erase a Metrics rate limit.
export class RefreshBackoff {
  constructor({interval, now = Date.now}) {
    this.interval = Math.max(1000, interval)
    this.maximum = Math.max(this.interval, 5 * 60_000)
    this.now = now
    this.sources = new Map()
  }

  get remaining() {
    return Math.max(0, ...[...this.sources.values()].map(state => state.until - this.now()))
  }

  record(source, failures = []) {
    if (!failures.length) this.sources.delete(source)
    else {
      const count = Math.min(30, (this.sources.get(source)?.count ?? 0) + 1)
      const backoff = Math.min(this.maximum, this.interval * 2 ** (count - 1))
      const retryAfter = Math.max(0, ...failures.map(failure => Number.isFinite(failure.retryAfterMs)
        ? failure.retryAfterMs : failure.statusCode === 429 ? 60_000 : 0))
      this.sources.set(source, {count, until: this.now() + Math.max(backoff, retryAfter)})
    }
    return this.remaining
  }
}
