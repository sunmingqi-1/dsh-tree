import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { createPortal } from 'react-dom'
import { MarkdownDelegateProvider, FenceCodeBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  fileMediaUrl,
  resolveWorkspacePath,
  sessionFileAddress,
} from '@deepseek-ai/dsh-util-workspace-path'
import { controlSeat, mirrorNativeControl } from './nativeControls'
import { turnKeys, processVisibility } from './turnSlice'
import { useStudy } from './WorkspaceTree'
import { nearestTurn } from './tree'

export const turnSeat = 'studyTree.card.turn'
const motion = {
  collapse: (_element, commit) => commit(),
  reveal: () => {},
  cancelMotion: () => {},
}
const flowContext = { motion }
const resetSource = { getSnapshot: () => 0, subscribe: () => () => {} }

export function NativeTurnSeat({ study, node, children, reader = false }) {
  const ref = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  useLayoutEffect(() => {
    if (!ref.current || !node.sessionId || !node.requestId) return
    const element = ref.current
    setReady(false)
    study.turns.seats.set(element, { node, reader, key: crypto.randomUUID(), onReady: setReady })
    study.turns.emit()
    return () => {
      study.turns.seats.delete(element)
      study.turns.emit()
    }
  }, [study, node.id, node.sessionId, node.requestId, node.activeTurns?.join(',')])
  return (
    <div ref={ref} className="st-native-turn" data-answer={reader ? undefined : node.id}>
      {!ready && children}
    </div>
  )
}

const NativeTurnPortal = React.memo(function NativeTurnPortal({ study, seat, node, reader, onReady, reconnect, SessionProvider, renderSlot }) {
  const [reference, setReference] = useState(null)
  const [error, setError] = useState(''),
    [retry, setRetry] = useState(0)
  useEffect(() => {
    let alive = true
    let ref,
      held = false,
      released = false
    const release = () => {
      if (ref && !released) {
        released = true
        ref.release()
      }
    }
    setReference(null)
    setError('')
    const fail = (error) => {
      release()
      if (alive) {
        setError(error.message)
        study.issues.set(node.id, error.message)
        study.emit()
      }
    }
    try {
      ref = study.ctx.sessions.retain(node.sessionId, { source: 'studyTree.turn' })
    } catch (error) {
      fail(error)
      return
    }
    void ref.ready
      .then(async (binding) => {
        const parent = study.nodes.find((n) => n.id === node.parentId)
        await binding.session.loadThrough(parent ? nearestTurn(study.nodes, parent)?.endSeq ?? 0 : 0)
        if (!alive) return
        study.turns.bindings.set(node.sessionId, study.ctx.uiConversation.binding(binding))
        study.turns.holds.set(node.sessionId, (study.turns.holds.get(node.sessionId) || 0) + 1)
        held = true
        study.issues.delete(node.id)
        setReference(ref)
        study.turns.emit()
      })
      .catch(fail)
    return () => {
      alive = false
      if (held) {
        const left = study.turns.holds.get(node.sessionId) - 1
        if (left) study.turns.holds.set(node.sessionId, left)
        else {
          study.turns.holds.delete(node.sessionId)
          study.turns.bindings.delete(node.sessionId)
        }
        study.turns.emit()
      }
      release()
    }
  }, [node.id, node.sessionId, reconnect, retry])
  if (!reference)
    return error
      ? createPortal(
          <div className="st-turn-error" role="alert">
            暂时无法加载原生回复。
            <button onClick={() => setRetry((value) => value + 1)}>重新加载</button>
          </div>,
          seat,
        )
      : null
  return createPortal(
    <SessionProvider session={reference}>
      {renderSlot(turnSeat, {
        studyNode: node, study, onReady, reader,
        statusSeat: reader ? null : seat.closest('.st-card')?.querySelector('.st-completed-status'),
      }, { hookContext: flowContext })}
    </SessionProvider>,
    seat,
  )
})

export function NativeTurnBridge({ study, sessionId, SessionProvider, renderSlot }) {
  useStudy(study)
  useSyncExternalStore(study.turns.subscribe, study.turns.getSnapshot)
  if (!study.enabled || study.ctx.uiSession.adapter.current.getSnapshot().key !== sessionId)
    return null
  return (
    <>
      {[...study.turns.seats].map(([seat, { node, reader, key, onReady }]) => (
        <NativeTurnPortal
          key={key}
          {...{
            study,
            seat,
            node, reader,
            onReady,
            reconnect: study.turns.reconnect,
            SessionProvider,
            renderSlot,
          }}
        />
      ))}
    </>
  )
}

const NativeRow = React.memo(function NativeRow({ nodeKey, owner }) {
  const {
    useChatNode,
    useChatNodeProcess,
    useGroupAction,
    renderSlot,
    expanded,
    setExpanded,
    readerNodeId,
    statusSeat,
    lastTurn,
    ...callbacks
  } = owner
  const node = useChatNode(nodeKey)
  const process = useChatNodeProcess(nodeKey)
  const visibility = processVisibility(node, process, expanded)
  const reveal = React.useCallback(() => setExpanded(true), [setExpanded])
  const wrapper = useGroupAction(visibility.hidden, reveal)
  const turnProcess = useMemo(
    () =>
      process === undefined
        ? undefined
        : {
            spec: process.spec,
            foldable: visibility.foldable,
            hasContent: visibility.hasContent,
            open: visibility.open,
            setOpen: setExpanded,
          },
    [process, visibility.foldable, visibility.hasContent, visibility.open, setExpanded],
  )
  const turnData =
    node?.location.kind === 'turn' || node?.location.kind === 'step'
      ? node.location.turn.data
      : undefined
  const hookContext = useMemo(
    () => ({ turnData, disclosureReset: resetSource, useGroupAction }),
    [turnData, useGroupAction],
  )
  if (!node) return null
  const row = (
    <div
      ref={wrapper}
      className="st-native-row"
      data-answer={node.kind === 'assistant-step' ? readerNodeId : undefined}
      data-chat-flow-kind={node.kind}
      data-chat-node-key={node.key}
      data-chat-turn={node.location.turn?.turn}
    >
      {renderSlot(
        controlSeat('conversation.chat.node'),
        { ...callbacks, node, turnProcess },
        {
          entryKey: node.kind,
          hookContext,
          fallback: <div className="st-turn-unknown">此内容可在右侧原生对话中查看。</div>,
        },
      )}
    </div>
  )
  const turn = node.location.turn
  return node.kind === 'turn-process' && statusSeat && turn?.end?.data.reason.kind === 'completed'
    && (lastTurn === undefined || turn.turn === lastTurn)
    ? createPortal(row, statusSeat) : row
})

function NativeTurnView(props) {
  const {
    studyNode,
    reader,
    statusSeat,
    study,
    onReady,
    useChat,
    useChatNode,
    useChatNodeProcess,
    useGroupAction,
    renderSlot,
    openFile,
    openExternalLink,
    resolveFilePath,
    loadImage,
    inspectCall,
    forkAt,
    useSessions,
    useContextMenu,
    fileDrag,
    t,
  } = props
  const signature = useChat((snapshot) => turnKeys(snapshot, studyNode.requestId, reader, studyNode.activeTurns ?? (studyNode.logged ? [studyNode.turn] : undefined)))
  const [expanded, updateExpanded] = useState<boolean | null>(() => {
    try {
      const saved = localStorage.getItem('dsh-study-tree:process:' + studyNode.id)
      if (saved === 'true' || saved === 'false') return saved === 'true'
    } catch {
      // Without a stored choice, follow the turn's default disclosure.
    }
    return null
  })
  const setExpanded = React.useCallback(
    (value) => {
      updateExpanded(value)
      try {
        localStorage.setItem('dsh-study-tree:process:' + studyNode.id, String(value))
      } catch {}
    },
    [studyNode.id],
  )
  useEffect(() => {
    if (reader) return
    const reveal = () => setExpanded(true)
    study.turns.reveal.set(studyNode.id, reveal)
    return () => { if (study.turns.reveal.get(studyNode.id) === reveal) study.turns.reveal.delete(studyNode.id) }
  }, [study, studyNode.id, setExpanded])
  const cwd = useSessions((snapshot) => snapshot.byId[studyNode.sessionId]?.cwd)
  const lastTurn = studyNode.activeTurns?.at(-1) ?? studyNode.turn
  const owner = useMemo(
    () => ({
      useChatNode,
      useChatNodeProcess,
      useGroupAction,
      renderSlot,
      cwd,
      openFile,
      loadImage,
      inspectCall,
      forkAt: () => study.open(studyNode.id),
      readerNodeId: reader ? studyNode.id : undefined,
      statusSeat,
      lastTurn,
      expanded,
      setExpanded,
    }),
    [
      useChatNode,
      useChatNodeProcess,
      useGroupAction,
      renderSlot,
      cwd,
      openFile,
      loadImage,
      inspectCall,
      forkAt,
      statusSeat,
      lastTurn,
      expanded,
      setExpanded,
    ],
  )
  const { getTriggerProps } = useContextMenu()
  const trigger = React.useCallback(
    (target) =>
      getTriggerProps(() =>
        target.kind === 'file'
          ? {
              kind: 'file',
              value: {
                sessionId: studyNode.sessionId,
                path: resolveFilePath(target.path),
                line: target.line,
              },
            }
          : {
              kind: target.kind,
              value: {
                sessionId: studyNode.sessionId,
                url: target.url,
                ...(target.name === undefined ? {} : { name: target.name }),
                ...(target.mediaType === undefined ? {} : { mediaType: target.mediaType }),
                ...(target.path === undefined ? {} : { path: resolveFilePath(target.path) }),
              },
            },
      ),
    [getTriggerProps, studyNode.sessionId, resolveFilePath],
  )
  const fileImages = useMemo(
    () => ({
      fileDrag,
      resolve: (path) => fileMediaUrl(document.baseURI, resolveWorkspacePath(cwd, path)),
      resourceAddress: (path) =>
        sessionFileAddress(studyNode.sessionId, resolveWorkspacePath(cwd, path)),
      labels: {
        open: t('image.open'),
        loading: t('image.loading'),
        failed: t('image.failed'),
        dialog: t('image.dialog'),
        close: t('image.close'),
      },
    }),
    [cwd, studyNode.sessionId, fileDrag, t],
  )
  const labels = useMemo(
    () => ({
      copyLabel: t('copy'),
      copiedLabel: t('copied'),
      toolbarLabels: {
        codeLabel: t('codeBlock.title'),
        wrapLabel: t('codeBlock.wrap'),
        unwrapLabel: t('codeBlock.unwrap'),
      },
    }),
    [t],
  )
  const renderCode = React.useCallback(
    (fence) =>
      renderSlot(controlSeat('conversation.chat.markdown.fence'), fence, {
        entryKey: fence.lang,
        children: (
          <FenceCodeBlock
            code={fence.code}
            lang={fence.lang}
            streaming={fence.streaming}
            labels={labels}
            diff={false}
          />
        ),
      }),
    [renderSlot, labels],
  )
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const host = ref.current?.closest<HTMLElement>('.st-native-turn')
    if (host) host.dataset.nativeReady = signature ? 'true' : 'false'
    onReady(!!signature)
    return () => {
      if (host) delete host.dataset.nativeReady
      onReady(false)
    }
  }, [signature])
  return (
    <div ref={ref} className="st-turn-flow">
      <MarkdownDelegateProvider
        openFile={openFile}
        openExternalLink={openExternalLink}
        getTriggerProps={trigger}
        renderCode={renderCode}
        fileImages={fileImages}
      >
        {signature
          .split('\u001f')
          .filter(Boolean)
          .map((key) => (
            <NativeRow key={key} nodeKey={key} owner={owner} />
          ))}
      </MarkdownDelegateProvider>
    </div>
  )
}

// Adapt metadata from the public registry; never import/copy private DSH views.
export function installNativeTurns(ctx) {
  return ctx.slots.inject(turnSeat, () => installActiveTurns(ctx))
}
function installActiveTurns(ctx) {
  let disposed = false
  let dispose = () => {}
  let previous: any[] = []
  const sync = () => {
    if (disposed) return
    const view = ctx.slots.entries('conversation.view').find((entry) => entry.options.id === 'chat')
    const flow = ctx.slots.entries('conversation.chat.flow')[0]
    if (previous[0] === view && previous[1] === flow) return
    previous = [view, flow]
    dispose()
    dispose = () => {}
    if (!view || !flow) return
    const stop = ctx.slots.register(
      {
        name: turnSeat,
        store: view.store,
        locale: view.locale,
        inject: view.inject,
        children: {
          [controlSeat('conversation.chat.node')]: flow.children['conversation.chat.node'],
          [controlSeat('conversation.chat.markdown.fence')]:
            view.children['conversation.chat.markdown.fence'],
        },
      },
      NativeTurnView,
    )
    const stopNodes = mirrorNativeControl(ctx, 'conversation.chat.node')
    const stopFences = mirrorNativeControl(ctx, 'conversation.chat.markdown.fence')
    dispose = () => {
      stopFences()
      stopNodes()
      stop()
    }
  }
  const off = ['conversation.view', 'conversation.chat.flow'].map((name) =>
    ctx.slots.subscribe(name, sync),
  )
  sync()
  return () => {
    disposed = true
    off.forEach((stop) => stop())
    dispose()
  }
}

export function nativeTurnSpec(ctx) {
  return {
    kind: 'single',
    scope: 'session',
    inject: ctx.slots.entries('conversation.view').find((entry) => entry.options.id === 'chat')
      ?.children?.['conversation.chat.flow']?.inject,
  }
}
