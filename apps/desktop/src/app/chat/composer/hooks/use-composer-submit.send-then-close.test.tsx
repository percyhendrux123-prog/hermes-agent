import { useStore } from '@nanostores/react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useLayoutEffect, useRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import type { ChatBarProps } from '../types'

// The page is real (draft DOM, persistence, submit hook); only the assistant-ui adapter is
// substituted. A "window close" is the page's own pagehide flush plus a fresh module graph, so
// nothing the dead page held in memory survives into the next load: only localStorage does.
const composer = vi.hoisted(() => {
  let text = ''
  const listeners = new Set<() => void>()

  const runtime = {
    getState: () => ({ text }),
    subscribe: (listener: () => void) => {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    }
  }

  const api = {
    setText: (value: string) => {
      text = value
      listeners.forEach(listener => listener())
    }
  }

  return { aui: { composer: () => api }, runtime }
})

// The stored transcript the owner serves for a session (the REST page the outbox reads on reopen).
const transcript = vi.hoisted(() => ({ rows: new Map<string, unknown[]>() }))

vi.mock('@/api/sessions', async importOriginal => ({
  ...(await importOriginal<object>()),
  getSessionMessages: async (id: string) => ({
    messages: transcript.rows.get(id) ?? [],
    pagination: { limit: 200, offset: 0, order: 'latest' },
    session_id: id
  })
}))

vi.mock('@assistant-ui/react', () => ({
  useAui: () => composer.aui,
  useAuiState: (selector: (state: { composer: { text: string } }) => unknown) =>
    selector({ composer: composer.runtime.getState() }),
  useComposerRuntime: () => composer.runtime
}))

interface Handles {
  editor: () => string
  submitDraft: () => void
}

let handles: Handles

// One app page: fresh imports of the composer hooks and stores (as a reload or relaunch gets).
// Opening the session resumes it: the owner's snapshot lists its pending admissions (`pending`).
async function openPage(onSubmit: ChatBarProps['onSubmit'], pending: unknown[] = []) {
  const { reconcilePendingSubmissions } = await import('@/store/pending-submissions')
  const { useComposerDraft } = await import('./use-composer-draft')
  const { useComposerSubmit } = await import('./use-composer-submit')
  const { mainComposerScope } = await import('@/store/composer')
  const { composerPlainText } = await import('../rich-editor')

  function Page() {
    const attachments = useStore(mainComposerScope.$attachments)
    const queueEditRef = useRef(null)

    const draft = useComposerDraft({
      activeQueueSessionKey: 'stored-B',
      focusKey: 'rt-B',
      inputDisabled: false,
      queueEditRef,
      sessionId: 'rt-B'
    })

    const submit = useComposerSubmit({
      ...draft,
      activeQueueSessionKey: 'stored-B',
      attachments,
      busy: false,
      disabled: false,
      inputDisabled: false,
      drainNextQueued: async () => false,
      exitQueuedEdit: () => false,
      onCancel: () => {},
      onSteer: async () => false,
      onSteerHidden: async () => false,
      onSubmit,
      queueCurrentDraft: () => false,
      queueEdit: null,
      queuedPrompts: [],
      sessionId: 'rt-B'
    })

    useLayoutEffect(() => {
      handles = {
        editor: () => composerPlainText(draft.editorRef.current!).trim(),
        submitDraft: submit.submitDraft
      }
    })

    return <div contentEditable data-testid="editor" ref={draft.editorRef} />
  }

  const page = render(<Page />)
  reconcilePendingSubmissions('stored-B', pending)

  return page
}

function closeWindow() {
  act(() => window.dispatchEvent(new Event('pagehide')))
  cleanup()
  vi.resetModules()
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  transcript.rows.clear()
  vi.resetModules()
})

const outboxKeys = () =>
  Object.keys(window.localStorage).filter(key => key.startsWith('hermes:composer-outbox:'))

it('a message sent right before the window closes is never lost and never sent twice', async () => {
  window.localStorage.setItem('hermes:composer-drafts:v3', JSON.stringify({ 'stored-B': 'answered question' }))

  // Control: an acknowledged send leaves nothing behind for the next page.
  await openPage(async () => true)
  expect(handles.editor()).toBe('answered question')
  await act(async () => handles.submitDraft())
  closeWindow()

  const relaunched = vi.fn<ChatBarProps['onSubmit']>(async () => true)
  await openPage(relaunched)
  await act(async () => {})
  expect(handles.editor()).toBe('')
  closeWindow()

  // Enter, then the window closes before the send chain reaches prompt.submit.
  window.localStorage.setItem('hermes:composer-drafts:v3', JSON.stringify({ 'stored-B': 'my long question' }))
  const cutOff = vi.fn<ChatBarProps['onSubmit']>(() => new Promise<boolean>(() => {}))
  await openPage(cutOff)
  act(() => handles.submitDraft())
  expect(cutOff).toHaveBeenCalledTimes(1)
  const firstId = cutOff.mock.calls[0][1]?.submission_id
  expect(handles.editor()).toBe('')
  closeWindow()

  const reopened = vi.fn<ChatBarProps['onSubmit']>(async () => true)
  await openPage(reopened)
  await waitFor(() => expect(handles.editor()).toBe('my long question'))

  // Sending it again is the explicit retry of the same admission, so the owner runs it once.
  await act(async () => handles.submitDraft())
  expect(reopened).toHaveBeenCalledTimes(1)
  expect(reopened.mock.calls[0][0].trim()).toBe('my long question')
  expect(reopened.mock.calls[0][1]?.submission_id).toBe(firstId)
})

it('a send the owner admitted before the window closed is never offered again as the draft', async () => {
  // Admitted and run (its stored user row names it), admitted and still queued (the resume snapshot
  // lists it), or listed only by a snapshot that came after the draft was offered.
  const queued = (id: string, text: string) => [{ admission_id: 'adm-1', input_id: id, status: 'queued', text }]

  const landed = {
    late: (id: string) => ({ late: queued(id, 'late one') }),
    queued: (id: string) => ({ pending: queued(id, 'queued one') }),
    ran: (id: string) => ({ row: { content: 'ran one', display_metadata: { submission_id: id }, role: 'user' } })
  }

  const cases = [['ran one', landed.ran], ['queued one', landed.queued], ['late one', landed.late]] as const

  for (const [text, owner] of cases) {
    // Enter, the frame reaches the owner, and the window closes before the ack comes back.
    window.localStorage.setItem('hermes:composer-drafts:v3', JSON.stringify({ 'stored-B': text }))
    const unacked = vi.fn<ChatBarProps['onSubmit']>(() => new Promise<boolean>(() => {}))
    await openPage(unacked)
    act(() => handles.submitDraft())
    const held = owner(unacked.mock.calls[0][1]?.submission_id ?? '')
    closeWindow()

    transcript.rows.set('stored-B', 'row' in held ? [held.row] : [])
    const reopened = vi.fn<ChatBarProps['onSubmit']>(async () => true)
    await openPage(reopened, 'pending' in held ? held.pending : [])
    await waitFor(() => expect(outboxKeys()).toEqual([]))
    await act(async () => {})

    if ('late' in held) {
      expect(handles.editor()).toBe(text)
      const { reconcilePendingSubmissions } = await import('@/store/pending-submissions')
      act(() => reconcilePendingSubmissions('stored-B', held.late))
    }

    // Shown once (in the chat), never also back in the composer.
    expect(handles.editor()).toBe('')
    expect(reopened).not.toHaveBeenCalled()
    closeWindow()
    window.localStorage.clear()
  }
})
