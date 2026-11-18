import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useStudy } from './WorkspaceTree'
import { controlSeat, mirrorNativeControl } from './nativeControls'

const composerBar = 'conversation.composer.bar'
const sharedSeat = (name: string) => 'studyTree.shared.' + name
const sharedId = 'dsh-study-tree.shared-composer'

// One native editor per Session. Move its portal host without remounting it.
export function installSharedComposer(ctx, study) {
  return ctx.slots.inject(composerBar, () => {
    function SharedBar({ renderSlot, sessionId, ...props }) {
      useStudy(study)
      const drafts = study.composers
      useSyncExternalStore(drafts.subscribe, drafts.getSnapshot)
      const home = useRef<HTMLDivElement>(null)
      const [host] = useState(() => document.createElement('div'))
      const [readerNode, setReaderNode] = useState(null)
      const canvas = study.enabled && props.variant !== 'hero' && props.occurrence !== 'embedded' && sessionId
        && study.ctx.uiSession.adapter.current.getSnapshot().key === sessionId
      const card = canvas ? [...drafts.seats].find(([, request]) => request.shared && request.parent.id === study.active
        && request.parent.sessionId === sessionId) : undefined
      const atHome = !card || (readerNode === study.active && drafts.readerVisible)
      useLayoutEffect(() => {
        const target = atHome ? home.current : card[0]
        target?.appendChild(host)
        return () => { host.remove() }
      }, [host, atHome, card?.[0]])
      useEffect(() => { if (!drafts.readerVisible) setReaderNode(null) }, [drafts.readerVisible])
      const allowed = !canvas || (!!card && !card[1].sent && !card[1].pending)
      return <>
        <div ref={home} hidden={!!canvas && !card} />
        {card && !atHome && <button className="st-shared-input-switch" type="button" onClick={() => setReaderNode(study.active)}>在右侧输入</button>}
        {card && atHome && <button className="st-shared-input-switch" type="button" onClick={() => setReaderNode(null)}>移回卡片输入</button>}
        {canvas && !card && <div className="st-reader-input-hint">可在选中卡片中继续提问</div>}
        {createPortal(renderSlot(sharedSeat(composerBar), {
          ...props, disabled: props.disabled || !allowed, occurrence: atHome ? props.occurrence : 'embedded',
        }), host)}
      </>
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
  const [reference, setReference] = useState(undefined), [error, setError] = useState('')
  const [branch, setBranch] = useState(false)
  const branchRequest = useRef(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const active = branch ? { ...request, kind: 'card-branch' } : request
    branchRequest.current = branch ? active : null
    const stop = study.composers.mount(active, ref => {
      request.shared = !!ref && active.kind === 'card'
      setReference(ref)
      study.composers.emit()
    }, setError)
    return () => { request.shared = false; stop() }
  }, [study, request.key, retry, branch])
  useEffect(() => {
    if (!reference || (!branch && (request.kind !== 'quote' || !request.focus))) return
    const timer = requestAnimationFrame(() => seat.querySelector<HTMLElement>('[data-composer-input]')?.focus())
    return () => cancelAnimationFrame(timer)
  }, [reference])
  if (request.shared) return null
  if (reference === null && !branch && !error) return createPortal(
    <div className="st-history-composer">
      {study.composers.pendingQuote(request.parent.id) && <span>已引用：{study.composers.pendingQuote(request.parent.id).text}</span>}
      <button type="button" onClick={() => { setReference(undefined); setBranch(true) }}>从此处分支追问</button>
    </div>, seat,
  )
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
      {renderSlot(controlSeat(composerBar), {
        variant: 'composer', occurrence: 'embedded',
        disabled: request.sent || request.pending || branchRequest.current?.sent || branchRequest.current?.pending,
        placeholder: !reference ? request.parent.endSeq == null ? '等待当前回答结束…' : '正在准备输入框…'
          : request.kind === 'quote' ? '围绕选中文字继续提问…' : '发消息或创建任务，/ 调用指令，@ 文件或对话',
        studySimplified: request.kind === 'quote',
        studyAnchor: request.anchor,
      })}
    </SessionProvider>, seat,
  )
}

export function installBranchComposer(ctx) {
  return mirrorNativeControl(ctx, composerBar, entry => entry.options.priority === -100 && entry.options.id === sharedId)
}

export function NativeComposerBridge({ study, sessionId, SessionProvider, renderSlot }) {
  useStudy(study)
  useSyncExternalStore(study.composers.subscribe, study.composers.getSnapshot)
  if (!study.enabled || study.ctx.uiSession.adapter.current.getSnapshot().key !== sessionId) return null
  return <>{[...study.composers.seats].map(([seat, request]) => (
    <NativeComposerPortal key={request.key} {...{ study, seat, request, SessionProvider, renderSlot }} />
  ))}</>
}
