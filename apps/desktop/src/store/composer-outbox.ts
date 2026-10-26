import { freshDraftScope } from './composer'
import type { ComposerDraftRetry } from './composer-draft-retry'

// Enter clears the composer and hands the words to an async send chain (session resume or create,
// attachment sync, the prepared journal) before `prompt.submit` is written. Closing or reloading the
// window inside that gap ended the page with the words only in JS memory: nothing reached the
// backend, and the emptied draft is what persisted. Each send is journaled here synchronously at
// Enter and retired once the composer knows its outcome (accepted, or given back by the rejection
// path). An entry no live page holds is a send its page never finished: the next load of its draft
// scope restores it as the draft with its retry identity, so sending it again is the explicit retry
// under the same submission id and the owner never runs it twice. Restored, never re-sent on its
// own: like the prepared journal, this is not an automatic outbox.
const PREFIX = 'hermes:composer-outbox:v1:'

interface OutboxEntry {
  scope: string
  retry: ComposerDraftRetry
}

// Journal keys of sends this page has in flight: key -> release of the Web Lock that marks the
// entry as owned by a live page for every other window of the origin.
const ownedHere = new Map<string, () => void>()

const scopeKey = (scope: string | null | undefined) => scope?.trim() || freshDraftScope()
const entryKey = (scope: string, id: string) => `${PREFIX}${JSON.stringify([scope, id])}`
const lockName = (key: string) => `${key}:owner`

const locks = () => (typeof navigator === 'undefined' ? undefined : navigator.locks)

function read(key: string): OutboxEntry | undefined {
  try {
    const entry = JSON.parse(window.localStorage.getItem(key) || 'null') as OutboxEntry | null

    return entry && typeof entry.scope === 'string' && typeof entry.retry?.text === 'string' ? entry : undefined
  } catch {
    return undefined
  }
}

function write(key: string, entry: OutboxEntry | undefined): void {
  try {
    if (entry) {
      window.localStorage.setItem(key, JSON.stringify(entry))
    } else {
      window.localStorage.removeItem(key)
    }
  } catch {
    // Best-effort like the draft text itself (quota/private mode never blocks a send).
  }
}

function hold(key: string): void {
  ownedHere.set(key, () => undefined)
  void locks()?.request(lockName(key), () =>
    ownedHere.has(key) ? new Promise<void>(release => ownedHere.set(key, release)) : undefined
  )
}

export interface OutgoingSend {
  /** The send's draft scope changed (a fresh chat's create handoff assigned its session). */
  move: (scope: string | null) => void
  /** The composer knows the outcome: drop the entry and release its owner lock. */
  retire: () => void
}

/** Journal one send synchronously, before any await of the send chain can be cut by unload. */
export function journalOutgoingSend(scope: string | null, retry: ComposerDraftRetry): OutgoingSend {
  let key = entryKey(scopeKey(scope), retry.id)
  write(key, { scope: scopeKey(scope), retry })
  hold(key)

  const release = () => {
    write(key, undefined)
    const unlock = ownedHere.get(key)
    ownedHere.delete(key)
    unlock?.()
  }

  return {
    move: next => {
      if (!ownedHere.has(key) || entryKey(scopeKey(next), retry.id) === key) {
        return
      }

      release()
      key = entryKey(scopeKey(next), retry.id)
      write(key, { scope: scopeKey(next), retry })
      hold(key)
    },
    retire: release
  }
}

/** Offer `scope`'s interrupted send (one no live page owns) to `apply`; the entry is removed only
 *  when `apply` took it, so a composer the user already typed into leaves it for the next load. */
export async function restoreInterruptedSend(
  scope: string | null | undefined,
  apply: (retry: ComposerDraftRetry) => boolean
): Promise<void> {
  const target = scopeKey(scope)
  const keys: string[] = []

  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index)

    if (key?.startsWith(PREFIX) && !ownedHere.has(key) && read(key)?.scope === target) {
      keys.push(key)
    }
  }

  const take = (key: string) => {
    const entry = read(key)

    if (entry && !ownedHere.has(key) && apply(entry.retry)) {
      write(key, undefined)
    }
  }

  const available = locks()

  for (const key of keys.sort()) {
    if (!available) {
      take(key)
    } else {
      // A held lock is another live window's send still in flight: never adopted from here.
      await available.request(lockName(key), { ifAvailable: true }, lock => void (lock && take(key)))
    }
  }
}
