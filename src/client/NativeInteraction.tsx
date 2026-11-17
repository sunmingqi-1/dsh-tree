import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Square } from 'lucide-react'
import { useStudy } from './WorkspaceTree'
import { controlSeat, mirrorNativeControl } from './nativeControls'
import { pendingSource } from './nativeState'
import { turnNumber } from './turnSlice'

function usePendingOwner(study, pending) {
  useSyncExternalStore(study.turns.subscribe, study.turns.getSnapshot)
  const owner = study.interactions.owner(pending)
  const conversation = pending && study.turns.bindings.get(pending.sessionId)
  useEffect(() => {
    if (!pending || owner || !conversation) return
    const retry = () => {
      if (study.interactions.owner(pending)) study.turns.emit()
    }
    const stops = [
      conversation.target('chat').subscribe(retry),
      conversation.openTurn.subscribe(retry),
    ]
    retry()
    return () => stops.forEach((stop) => stop())
  }, [study, pending, owner, conversation])
  return owner
}

export function useNodePending(study, node) {
  const source = React.useMemo(() => pendingSource(study.ctx.uiSession), [study])
  const pending = useSyncExternalStore(source.subscribe, () => source.get(node?.sessionId))
  const owner = usePendingOwner(study, pending)
  return pending && owner === node?.id ? pending : null
}

// A stable portal host moves between the original composer and the card. The
// native form stays mounted while the reader is hidden or the selection changes.
function InteractionRouter(props) {
  const { study, sessionId, renderSlotChain } = props
  useStudy(study)
  const home = useRef<HTMLDivElement>(null)
  const [host] = useState(() => {
    const element = document.createElement('div')
    element.className = 'st-native-interaction-content'
    return element
  })
  const owner = usePendingOwner(study, props.pendingInteraction)
  const seat = study.enabled && owner === study.active ? study.interactions.seats.get(owner) : null
  useLayoutEffect(() => {
    const key = props.pendingInteraction.key
    const leases = study.interactions.leases
    const main = home.current?.closest('[data-slot="main.conversation"]')
    if (main && (!leases.get(key)?.isConnected || leases.get(key) === host)) leases.set(key, host)
    const target = main && leases.get(key) === host && seat ? seat : home.current
    target?.appendChild(host)
    return () => {
      host.remove()
      if (leases.get(key) === host) leases.delete(key)
    }
  }, [host, seat, sessionId, props.pendingInteraction.key])
  return (
    <>
      <div ref={home} className="st-interaction-home" />
      {createPortal(
        renderSlotChain(controlSeat('conversation.composer'), {
          sessionId,
          session: props.session,
          pendingInteraction: props.pendingInteraction,
        }),
        host,
      )}
    </>
  )
}

export function installNativeInteractions(ctx, study) {
  return ctx.slots.inject('conversation.composer', () => {
    const Router = (props) => <InteractionRouter {...props} study={study} />
    let previous: any[] = [],
      stopRouter = () => {},
      busy = false,
      disposed = false
    const sync = () => {
      if (busy || disposed) return
      const entries = ctx.slots
        .entries('conversation.composer')
        .filter((entry) => entry.component !== Router)
      if (entries.length === previous.length && entries.every((entry, i) => entry === previous[i]))
        return
      previous = entries
      busy = true
      stopRouter()
      const selectors = entries.map((entry) => entry.select).filter(Boolean)
      stopRouter = ctx.slots.register(
        {
          name: 'conversation.composer',
          priority: -100,
          select: (owner) =>
            owner.pendingInteraction && selectors.some((select) => select(owner) !== null)
              ? owner.pendingInteraction
              : null,
          children: { [controlSeat('conversation.composer')]: { kind: 'chain', scope: 'session' } },
        },
        Router,
      )
      busy = false
    }
    const off = ctx.slots.subscribe('conversation.composer', sync)
    sync()
    const stopMirror = mirrorNativeControl(
      ctx,
      'conversation.composer',
      (entry) => entry.component === Router,
    )
    return () => {
      disposed = true
      off()
      stopMirror()
      stopRouter()
    }
  })
}

export function NativeInteractionSeat({ study, node }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    study.interactions.seats.set(node.id, element)
    study.turns.emit()
    return () => {
      study.interactions.seats.delete(node.id)
      study.turns.emit()
    }
  }, [study, node.id])
  return (
    <div
      ref={ref}
      className="st-native-interaction nodrag nopan nowheel"
      data-study-interaction={node.id}
    />
  )
}

export function RunningStatus({ study, node }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const stop = async (event) => {
    event.stopPropagation()
    setBusy(true)
    try {
      const binding = study.ctx.sessions.binding(node.sessionId)
      if (!binding) return
      const conversation = study.ctx.uiConversation.binding(binding)
      const chat = conversation.target('chat').getSnapshot()
      const turn = study.turnNumbers.get(node.id) ?? (chat && turnNumber(chat, node.requestId))
      if (
        turn === undefined ||
        !binding.session.getSnapshot().running ||
        conversation.openTurn.getSnapshot() !== turn
      )
        return
      const result = await binding.session.cancel()
      if (!result.ok) throw new Error(result.error.message)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="st-running-status nodrag nopan nowheel" role="status">
      <span>
        <i />
        {error || (node.status === 'preparing' ? '正在准备会话…' : 'DSH 正在回复…')}
      </span>
      {node.sessionId && (
        <button type="button" aria-label="停止当前回答" onClick={stop} disabled={busy}>
          <Square size={11} />
          停止
        </button>
      )}
    </div>
  )
}
