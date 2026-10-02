import {chmod, mkdir, readFile, writeFile} from 'node:fs/promises'
import {dirname, join} from 'node:path'

export const LOG_FILTER_HISTORY_LIMIT = 100

export async function loadLogFilterHistory(configDir) {
  const file = join(configDir, 'dash', 'log-filter-history.json')
  const histories = new Map()
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [scope, entries] of Object.entries(parsed)) {
        if (Array.isArray(entries)) histories.set(scope, entries.filter(value => typeof value === 'string' && value.trim()).slice(-LOG_FILTER_HISTORY_LIMIT))
      }
    }
  } catch {
    histories.clear()
  }

  return {
    entries(scope) { return histories.get(scope) ?? [] },
    async add(scope, value) {
      const filter = String(value)
      if (!scope || !filter.trim()) return
      // Spaces can be significant in regexes and literal log searches.
      histories.set(scope, [...(histories.get(scope) ?? []).filter(entry => entry !== filter), filter].slice(-LOG_FILTER_HISTORY_LIMIT))
      try {
        await mkdir(dirname(file), {recursive: true, mode: 0o700})
        await chmod(dirname(file), 0o700).catch(() => {})
        await writeFile(file, `${JSON.stringify(Object.fromEntries(histories), null, 2)}\n`, {mode: 0o600})
        await chmod(file, 0o600).catch(() => {})
      } catch {
        return
      }
    },
  }
}
