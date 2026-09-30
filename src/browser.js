import {spawn} from 'node:child_process'

export function openExternalURL(url, {spawnProcess = spawn, platform = process.platform} = {}) {
  return new Promise((resolve, reject) => {
    const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'rundll32' : 'xdg-open'
    const child = spawnProcess(command, platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url],
      {stdio: 'ignore', shell: false, windowsHide: true})
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`Browser exited with ${signal ?? `code ${code}`}.`))
    })
  })
}
