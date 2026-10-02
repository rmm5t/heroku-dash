import {join} from 'node:path'
import {addHistoryEntry, historyEntries, loadHistoryFile, saveHistoryFile} from './history-store.js'

export const LOG_FILTER_HISTORY_LIMIT = 100

export async function loadLogFilterHistory(configDir) {
  const file = join(configDir, 'dash', 'log-filter-history.json')
  const histories = new Map()
  const parsed = await loadHistoryFile(file)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [scope, entries] of Object.entries(parsed)) {
      if (Array.isArray(entries)) histories.set(scope, historyEntries(entries, LOG_FILTER_HISTORY_LIMIT))
    }
  }

  return {
    entries(scope) { return histories.get(scope) ?? [] },
    async add(scope, value) {
      const filter = String(value)
      if (!scope || !filter.trim()) return
      // Spaces can be significant in regexes and literal log searches.
      histories.set(scope, addHistoryEntry(histories.get(scope) ?? [], filter, LOG_FILTER_HISTORY_LIMIT))
      await saveHistoryFile(file, () => Object.fromEntries(histories))
    },
  }
}
