import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useStudy } from './WorkspaceTree'
import { controlSeat, mirrorNativeControl } from './nativeControls'

const composerBar = 'conversation.composer.bar'
const sharedSeat = (name: string) => 'studyTree.shared.' + name
const sharedId = 'dsh-study-tree.shared-composer'

export function installSharedComposer(ctx, study) {
  return ctx.slots.inject(composerBar, () => {
    function SharedBar({ renderSlot, sessionId, ...props }) {
      useStudy(study)
      const drafts = study.composers
      useSyncExternalStore(drafts.subscribe, drafts.getSnapshot)
      const home = useRef<HTMLDivElement>(null)
      const canvas = study.enabled && sessionId === study.ctx.uiSession.adapter.current.getSnapshot().key
      useLayoutEffect(() => {
        if (!canvas) return
        drafts.home = home.current
        drafts.emit()
        return () => { drafts.home = null; drafts.emit() }
      }, [canvas, drafts])
      if (!canvas) {
        const blocked = study.creating && study.pendingSession === sessionId && !study.rootReady
        return <>{blocked && study.error && <div role="alert">{study.error}</div>}
          {renderSlot(sharedSeat(composerBar), { ...props, disabled: props.disabled || blocked })}</>
      }
      const card = [...drafts.seats.values()].find(request => request.parent.id === study.active && request.kind === 'card')
      return <><div ref={home} />{card && <button className="st-shared-input-switch" onClick={() => {
        drafts.readerNode = drafts.readerNode === study.active ? null : study.active
        drafts.emit()
      }}>{drafts.readerNode === study.active ? '移回卡片输入' : '在右侧输入'}</button>}</>
    }
    const stop = ctx.slots.register({ name: composerBar, id: sharedId, priority: -100,
      children: { [sharedSeat(composerBar)]: { kind: 'single', scope: 'session-maybe' } },
    }, SharedBar)
    const unmirror = mirrorNativeControl(ctx, composerBar, entry => entry.component === SharedBar, undefined, sharedSeat)
    return () => { unmirror(); stop() }
  })
}

export function NativeComposerSeat({ study, parent, kind = 'card', anchor = null, focus = false }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!ref.current || !parent) return
    const seat = ref.current
    const request = { key: crypto.randomUUID(), parent, kind, anchor, focus }
    study.composers.seats.set(seat, request)
    study.composers.emit()
    return () => { study.composers.seats.delete(seat); study.composers.emit() }
  }, [study, parent?.id, parent?.endSeq, kind, anchor?.start, anchor?.text, focus])
  return <div ref={ref} className={'st-native-composer nodrag nopan nowheel ' + (kind === 'quote' ? 'simplified' : '')} data-study-composer={kind} />
}

function NativeComposerPortal({ study, seat, request, SessionProvider, renderSlot }) {
  const [reference, setReference] = useState(null), [error, setError] = useState('')
  const [host] = useState(() => document.createElement('div'))
  useLayoutEffect(() => {
    seat.appendChild(host)
    return () => host.remove()
  }, [seat, host])
  useLayoutEffect(() => study.composers.mount(request, setReference, setError), [study, request])
  useEffect(() => {
    if (!reference || !request.focus) return
    const timer = requestAnimationFrame(() => host.querySelector<HTMLElement>('[data-composer-input]')?.focus())
    return () => cancelAnimationFrame(timer)
  }, [reference, host, request.focus])
  return createPortal(reference ? <SessionProvider session={reference}>
    {renderSlot(controlSeat(composerBar), { variant: 'composer', occurrence: 'embedded',
      placeholder: request.kind === 'quote' ? '围绕选中文字继续提问…' : '继续提问…',
      studySimplified: request.kind === 'quote', studyAnchor: request.anchor })}
  </SessionProvider> : <div className="st-native-preparing" role={error ? 'alert' : 'status'}>{error || '正在准备输入框…'}</div>, host)
}

export function installBranchComposer(ctx) {
  return mirrorNativeControl(ctx, composerBar, entry => entry.options.priority === -100 && entry.options.id === sharedId)
}

export function NativeComposerBridge({ study, sessionId, SessionProvider, renderSlot }) {
  useStudy(study)
  const drafts = study.composers
  useSyncExternalStore(drafts.subscribe, drafts.getSnapshot)
  if (!study.enabled || study.ctx.uiSession.adapter.current.getSnapshot().key !== sessionId) return null
  const seats = [...drafts.seats]
  const target = seats.find(([, request]) => request.kind === 'quote') ||
    seats.find(([, request]) => request.parent.id === study.active)
  if (!target) return null
  const [card, request] = target
  const seat = request.kind === 'card' && drafts.readerVisible && drafts.readerNode === study.active && drafts.home || card
  return <NativeComposerPortal key={request.key} {...{ study, seat, request, SessionProvider, renderSlot }} />
}
