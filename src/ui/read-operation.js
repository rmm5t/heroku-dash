import {withAbort} from '../read-requests.js'

// Only current reads apply results, report errors, or redraw their view. A null
// outcome means canceled/handled failure; {value} also supports empty results.
// onStart can return cleanup that always runs after request ownership is released;
// onFinish is reserved for updating the current view before that release.
export async function runRead(owner, key, {label, isCurrent, read, onStart, onSuccess, onError, onFinish}) {
  const request = owner.readRequests.start(key, isCurrent)
  const {signal} = request.controller
  let cleanup = () => {}
  let finishLoading = () => {}
  try {
    if (!request.current()) return null
    cleanup = onStart?.(request) ?? cleanup
    if (label) finishLoading = owner.beginLoading(key, label)
    if (!request.current()) return null
    const value = await withAbort(read({signal}), signal)
    if (!request.current()) return null
    onSuccess?.(value)
    return {value}
  } catch (error) {
    if (!request.current()) return null
    if (!onError) throw error
    onError(error)
    return null
  } finally {
    try {
      if (request.current()) onFinish?.()
    } finally {
      request.finish()
      try { cleanup() }
      finally { finishLoading() }
    }
  }
}
