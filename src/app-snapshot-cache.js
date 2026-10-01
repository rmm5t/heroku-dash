// Session-only snapshots: config values and revealed state live separately.
export class AppSnapshotCache {
  constructor({limit = 8, ttl = 60_000, now = Date.now} = {}) {
    this.limit = limit
    this.ttl = ttl
    this.now = now
    this.entries = new Map()
  }

  get(id) {
    const entry = this.entries.get(id)
    if (!entry) return null
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(id)
      return null
    }
    this.entries.delete(id)
    this.entries.set(id, entry)
    return structuredClone(entry.data)
  }

  set(data) {
    if (!data.app?.id || data.pending?.length) return
    this.entries.delete(data.app.id)
    this.entries.set(data.app.id, {data: structuredClone(data), expiresAt: this.now() + this.ttl})
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value)
  }

  delete(id) { this.entries.delete(id) }

  clear() { this.entries.clear() }
}
