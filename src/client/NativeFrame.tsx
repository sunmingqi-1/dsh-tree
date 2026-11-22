import React, { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useStudy } from './WorkspaceTree'
import { StudyPage } from './StudyPage'
import { NativeTurnSeat } from './NativeTurn'
import { pathTo } from './tree'

// Keep the real Conversation mounted in its own slot. Add only the canvas beside it.
export function NativeFrame({ study, useSessions, usePanelInfo }) {
  useStudy(study)
  const source = study.ctx.uiSession.adapter.current
  const currentId = useSyncExternalStore(source.subscribe, () => source.getSnapshot().key)
  const selectedSession = useSessions((state) => state.byId[currentId])
  const panel = usePanelInfo((state) => state.activePanelId)
  const [frame, setFrame] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const locate = () => {
      const next = document.querySelector<HTMLElement>('[data-slot="main"]')?.parentElement
      if (next) setFrame((previous) => (previous === next ? previous : next))
    }
    locate()
    const observer = new MutationObserver(locate)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    // The native new-session action can replace one blank hero with another
    // while the first input is still arming. Carry the learning choice along.
    if (study.creating && study.pendingSession && selectedSession && !selectedSession.blank && study.pendingSession !== selectedSession.id) {
      study.pendingStop()
      study.creating = false
      study.emit()
    }
    if (study.creating && selectedSession?.blank && study.pendingSession !== selectedSession.id)
      study.armRoot(selectedSession.id)
    if (!study.enabled || !selectedSession) return
    const current = study.nodes.find((node) => node.id === study.active)
    if (study.nativeTarget === selectedSession.id) study.nativeTarget = null
    else if (
      !study.nativeTarget &&
      current?.sessionId &&
      current.sessionId !== selectedSession.id
    ) {
      study.enabled = false
      study.emit()
    }
  }, [selectedSession?.id, selectedSession?.blank, study.creating, study.enabled])
  const visible = study.enabled && panel === null && frame !== null
  useLayoutEffect(() => {
    if (!visible) return
    frame.dataset.studyCanvas = ''
    return () => {
      delete frame.dataset.studyCanvas
      delete frame.dataset.studyReader
      frame.style.removeProperty('--st-reader-width')
    }
  }, [frame, visible])
  if (!visible) return null
  return createPortal(
    <div className="st-dock">
      <StudyPage study={study} nativeFrame={frame} nativeSessionKey={currentId} />
    </div>,
    frame,
  )
}

export function NativeBoundary({
  study,
  path,
  frame,
  sessionKey,
  visible,
  width,
  readingState,
  onQuote,
}) {
  const signature = path.map((node) => node.id + ':' + study.turnNumbers.get(node.id)).join(',')
  useLayoutEffect(() => {
    frame.dataset.studyReader = String(visible)
    frame.style.setProperty('--st-reader-width', width + 'px')
    if (study.composers.readerVisible !== visible) {
      study.composers.readerVisible = visible
      study.composers.emit()
    }
  }, [frame, visible, width])
  useLayoutEffect(() => {
    const native = frame.querySelector<HTMLElement>(
      '[data-slot="main.conversation"] > :first-child',
    )
    if (!native) return
    native.classList.add('st-native-reader')
    const context = (event) => {
      if (!(event.target instanceof Element) || !event.target.closest('[data-answer]')) return
      if (!getSelection()?.toString()) return
      event.preventDefault()
      event.stopPropagation()
      onQuote(event)
    }
    native.addEventListener('contextmenu', context, true)
    let restored = false
    const scroll = (event) => {
      if (
        restored &&
        event.target instanceof HTMLElement &&
        event.target.hasAttribute('data-conversation-scroll')
      )
        readingState.onScroll(event.target.scrollTop)
    }
    native.addEventListener('scroll', scroll, true)
    const timer = requestAnimationFrame(() => {
      const scroller = native.querySelector<HTMLElement>('[data-conversation-scroll]')
      if (scroller && readingState.position !== undefined)
        scroller.scrollTop = readingState.position
      restored = true
    })
    return () => {
      cancelAnimationFrame(timer)
      native.removeEventListener('contextmenu', context, true)
      native.removeEventListener('scroll', scroll, true)
      native.classList.remove('st-native-reader')
    }
  }, [frame, signature, sessionKey])
  return null
}

// Use the resident native scrollport and one keyed native message renderer per
// path Turn. Sibling Turns never enter the reader, navigation or scroll policy.
export function installPathReader(ctx, study) {
  return ctx.slots.inject('conversation.session', () => {
    function PathReader() {
      useStudy(study)
      return <div className="st-path-reader">
        {pathTo(study.nodes, study.active).map(node => (
          <NativeTurnSeat key={node.id} study={study} node={node} reader>
            <p>{node.question}</p>
          </NativeTurnSeat>
        ))}
      </div>
    }
    let stop: (() => void) | undefined
    const sync = () => {
      if (study.enabled && !stop)
        stop = ctx.slots.register({ name: 'conversation.session', id: 'dsh-study-tree.path', priority: -100 }, PathReader)
      else if (!study.enabled && stop) { stop(); stop = undefined }
    }
    study.listeners.add(sync)
    sync()
    return () => { study.listeners.delete(sync); stop?.() }
  })
}
