import {join} from 'node:path'
import {addHistoryEntry, historyEntries, loadHistoryFile, saveHistoryFile} from './history-store.js'

export const COMMAND_HISTORY_LIMIT = 100

export async function loadCommandHistory(configDir) {
  const file = join(configDir, 'dash', 'command-history.json')
  let entries = historyEntries(await loadHistoryFile(file), COMMAND_HISTORY_LIMIT)

  const history = {
    entries,
    async add(value) {
      const command = String(value).trim()
      if (!command) return
      entries = addHistoryEntry(entries, command, COMMAND_HISTORY_LIMIT)
      history.entries = entries
      await saveHistoryFile(file, () => entries)
    },
  }
  return history
}
