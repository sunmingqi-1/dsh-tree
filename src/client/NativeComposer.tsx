import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useStudy } from './WorkspaceTree'
import { controlSeat } from './nativeControls'

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
  const [retry, setRetry] = useState(0)
  useEffect(() => request.kind === 'card' ? study.composers.warmQuote(request.parent) : undefined,
    [study, request.key])
  useEffect(() => study.composers.mount(request, setReference, setError), [study, request.key, retry])
  useEffect(() => {
    if (!reference || request.kind !== 'quote' || !request.focus) return
    const timer = requestAnimationFrame(() => seat.querySelector<HTMLElement>('[data-composer-input]')?.focus())
    return () => cancelAnimationFrame(timer)
  }, [reference])
  if (!reference && request.kind === 'quote' && !error) return null
  if (!reference) return createPortal(
    <div className="st-native-preparing" role={error ? 'alert' : 'status'}>
      {error || (request.parent.endSeq == null ? '等待当前回答结束…' : '正在准备输入框…')}
      {error && <button onClick={() => { setError(''); setRetry(value => value + 1) }}>重试</button>}
    </div>, seat,
  )
  return createPortal(
    <SessionProvider session={reference}>
      {error ? <div role="alert" className="st-composer-notice">{error}</div> : null}
      {renderSlot(controlSeat('conversation.composer.bar'), {
        variant: 'composer', occurrence: 'embedded',
        disabled: !reference || request.sent,
        placeholder: !reference ? request.parent.endSeq == null ? '等待当前回答结束…' : '正在准备输入框…'
          : request.kind === 'quote' ? '围绕选中文字继续提问…' : '发消息或创建任务，/ 调用指令，@ 文件或对话',
        studySimplified: request.kind === 'quote',
        studyAnchor: request.anchor,
      })}
    </SessionProvider>, seat,
  )
}

export function NativeComposerBridge({ study, sessionId, SessionProvider, renderSlot }) {
  useStudy(study)
  useSyncExternalStore(study.composers.subscribe, study.composers.getSnapshot)
  if (!study.enabled || study.ctx.uiSession.adapter.current.getSnapshot().key !== sessionId) return null
  return <>{[...study.composers.seats].map(([seat, request]) => (
    <NativeComposerPortal key={request.key} {...{ study, seat, request, SessionProvider, renderSlot }} />
  ))}</>
}
