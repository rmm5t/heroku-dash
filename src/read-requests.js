import {setMaxListeners} from 'node:events'

export function withAbort(promise, signal) {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      callback(value)
    }
    const abort = () => finish(reject, signal.reason)
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, {once: true})
  })
}

export class ReadRequests {
  constructor(isActive = () => true) {
    this.isActive = isActive
    this.requests = new Map()
  }

  start(key, isCurrent = () => true) {
    this.cancel(key)
    const controller = new AbortController()
    // A single read scope can fan out to many independently canceled HTTP calls.
    setMaxListeners(0, controller.signal)
    const request = {
      controller,
      current: () => this.isActive() && !controller.signal.aborted && this.requests.get(key) === request && isCurrent(),
      finish: () => { if (this.requests.get(key) === request) this.requests.delete(key) },
    }
    this.requests.set(key, request)
    if (!this.isActive() || !isCurrent()) controller.abort()
    return request
  }

  has(key) { return this.requests.get(key)?.current() ?? false }

  cancel(key) {
    const request = this.requests.get(key)
    this.requests.delete(key)
    request?.controller.abort()
  }

  cancelAll() {
    for (const key of this.requests.keys()) this.cancel(key)
  }
}
