// The input ids (client submission ids) the owner's latest pending snapshot lists per composer
// queue key, as this page saw them. A send the owner admitted but has not run yet (queued behind a
// running turn or an unresolved one) has no stored row, so only this listing shows that it landed.
const listed = new Map<string, Set<string>>()
const waiters = new Set<() => void>()

/** Record one pending snapshot of `key` (called by the pending-submissions reconcile). */
export function noteListedSubmissions(key: string, inputIds: Iterable<string>): void {
  listed.set(key, new Set(inputIds))
  waiters.forEach(wake => wake())
}

/** The ids `key`'s pending snapshot lists, waiting up to `timeoutMs` for this page's first one;
 *  `undefined` when none arrived (an owner that sends no snapshot): the caller then knows nothing. */
export function listedSubmissions(key: string, timeoutMs: number): Promise<Set<string> | undefined> {
  const now = listed.get(key)

  if (now) {
    return Promise.resolve(now)
  }

  return new Promise(resolve => {
    const done = () => {
      waiters.delete(wake)
      clearTimeout(timer)
      resolve(listed.get(key))
    }

    const wake = () => void (listed.has(key) && done())
    const timer = setTimeout(done, timeoutMs)
    waiters.add(wake)
  })
}
