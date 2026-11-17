import React, { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useStudy } from './WorkspaceTree'
import { StudyPage } from './StudyPage'

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
    if (study.creating && selectedSession?.blank && study.pendingSession !== selectedSession.id)
      study.armRoot(selectedSession.id)
    if (!study.enabled || !selectedSession) return
    const current = study.nodes.find((node) => node.id === study.active)
    if (study.nativeTarget === selectedSession.id) study.nativeTarget = null
    else if (
      !study.nativeTarget &&
      current?.sessionId &&
      current.sessionId !== selectedSession.id &&
      study.readerTarget?.sessionId !== selectedSession.id
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
  inputReady,
}) {
  const signature = path.map((node) => node.id + ':' + study.turnNumbers.get(node.id)).join(',')
  useLayoutEffect(() => {
    frame.dataset.studyReader = String(visible)
    frame.style.setProperty('--st-reader-width', width + 'px')
  }, [frame, visible, width])
  useLayoutEffect(() => {
    const native = frame.querySelector('[data-slot="main.conversation"] > :first-child')
    if (!native) return
    const update = () => {
      for (const seat of native.querySelectorAll<HTMLElement>('[data-composer-seat]')) seat.inert = !inputReady
    }
    update()
    const observer = new MutationObserver(update)
    observer.observe(native, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      for (const seat of native.querySelectorAll<HTMLElement>('[data-composer-seat]')) seat.inert = false
    }
  }, [frame, sessionKey, inputReady])
  useLayoutEffect(() => {
    const native = frame.querySelector<HTMLElement>(
      '[data-slot="main.conversation"] > :first-child',
    )
    if (!native) return
    native.classList.add('st-native-reader')
    const ids = new Map(path.map((node) => [String(study.turnNumbers.get(node.id)), node.id]))
    const allowed = [...ids.keys()]
      .filter((turn) => turn !== 'undefined')
      .map((turn) => '[data-chat-turn="' + turn + '"]')
      .join(',')
    const style = document.createElement('style')
    style.textContent = allowed
      ? '.st-native-reader [data-chat-turn]:not(' + allowed + '){display:none!important}'
      : '.st-native-reader [data-chat-turn]{visibility:hidden}'
    native.appendChild(style)
    const annotate = () => {
      for (const element of native.querySelectorAll<HTMLElement>(
        '[data-chat-flow-kind="assistant-step"][data-chat-turn] [data-text-interaction-source]',
      )) {
        const turn = element.closest<HTMLElement>('[data-chat-turn]')?.dataset.chatTurn
        if (ids.has(turn)) element.dataset.answer = ids.get(turn)
      }
    }
    annotate()
    const observer = new MutationObserver(annotate)
    observer.observe(native, { childList: true, subtree: true })
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
      observer.disconnect()
      native.removeEventListener('contextmenu', context, true)
      native.removeEventListener('scroll', scroll, true)
      native.classList.remove('st-native-reader')
      style.remove()
    }
  }, [frame, signature, sessionKey])
  return null
}
