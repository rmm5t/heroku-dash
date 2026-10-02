import {chmod, mkdir, readFile, writeFile} from 'node:fs/promises'
import {dirname} from 'node:path'

export function historyEntries(values, limit) {
  return Array.isArray(values) ? values.filter(value => typeof value === 'string' && value.trim()).slice(-limit) : []
}

export function addHistoryEntry(entries, value, limit) {
  return [...entries.filter(entry => entry !== value), value].slice(-limit)
}

export async function loadHistoryFile(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

export async function saveHistoryFile(file, getValue) {
  try {
    await mkdir(dirname(file), {recursive: true, mode: 0o700})
    await chmod(dirname(file), 0o700).catch(() => {})
    // Read the latest in-memory entries after asynchronous directory setup.
    await writeFile(file, `${JSON.stringify(getValue(), null, 2)}\n`, {mode: 0o600})
    await chmod(file, 0o600).catch(() => {})
  } catch {
    // History remains usable in memory when persistence is unavailable.
    return
  }
}
