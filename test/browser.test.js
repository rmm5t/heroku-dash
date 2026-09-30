import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import test from 'node:test'
import {openExternalURL} from '../src/browser.js'

for (const [platform, command] of [['darwin', 'open'], ['linux', 'xdg-open'], ['win32', 'rundll32']]) {
  test(`browser opening passes the URL as one argument without a shell on ${platform}`, async () => {
    const url = 'https://addons-sso.heroku.com/apps/app/attachments/id?one=1&two=2'
    await openExternalURL(url, {platform, spawnProcess(executable, args, options) {
      assert.equal(executable, command)
      assert.deepEqual(args, platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url])
      assert.equal(options.shell, false)
      assert.equal(options.stdio, 'ignore')
      const child = new EventEmitter()
      queueMicrotask(() => child.emit('close', 0))
      return child
    }})
  })
}

test('browser launch failures and nonzero exits reject cleanly', async () => {
  for (const event of ['error', 'close']) {
    await assert.rejects(openExternalURL('https://dashboard.heroku.com', {spawnProcess() {
      const child = new EventEmitter()
      queueMicrotask(() => event === 'error' ? child.emit('error', new Error('No browser launcher')) : child.emit('close', 1))
      return child
    }}), event === 'error' ? /No browser launcher/ : /Browser exited with code 1/)
  }
})
