import {chmod, mkdir, readFile, writeFile} from 'node:fs/promises'
import {dirname, join} from 'node:path'

export const COMMAND_HISTORY_LIMIT = 100

export async function loadCommandHistory(configDir) {
  const file = join(configDir, 'dash', 'command-history.json')
  let entries = []
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (Array.isArray(parsed)) entries = parsed.filter(value => typeof value === 'string' && value.trim()).slice(-COMMAND_HISTORY_LIMIT)
  } catch {
    entries = []
  }

  const history = {
    entries,
    async add(value) {
      const command = String(value).trim()
      if (!command) return
      entries = [...entries.filter(entry => entry !== command), command].slice(-COMMAND_HISTORY_LIMIT)
      history.entries = entries
      try {
        await mkdir(dirname(file), {recursive: true, mode: 0o700})
        await chmod(dirname(file), 0o700).catch(() => {})
        await writeFile(file, `${JSON.stringify(entries, null, 2)}\n`, {mode: 0o600})
        await chmod(file, 0o600).catch(() => {})
      } catch {
        return
      }
    },
  }
  return history
}
