// Cancellation stops queued work. Callers handle cancellation of in-flight
// jobs and decide whether to reject or keep the partial, input-ordered results.
export async function mapConcurrent(items, action, {concurrency = 4, signal} = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Concurrency must be a positive integer.')
  const results = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, async () => {
    while (next < items.length && !signal?.aborted) {
      const index = next++
      results[index] = await action(items[index], index)
    }
  }))
  return results
}
