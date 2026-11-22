import { createPortal } from 'react-dom'
import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  GitBranch,
  CornerDownRight,
  PanelRightOpen,
  PanelRightClose,
  Plus,
  Ellipsis,
  GripHorizontal,
  X,
} from 'lucide-react'
import {
  ReactFlow,
  Handle,
  Position,
  NodeResizer,
  useStoreApi,
} from '@xyflow/react'
import Markdown from 'react-markdown'
import gfm from 'remark-gfm'
import math from 'remark-math'
import katex from 'rehype-katex'
import { pathTo, type Turn } from './tree'
import { locate, selectionAt } from './selection'
import { NativeBoundary } from './NativeFrame'
import { CanvasBackground } from './CanvasBackground'
import { arrange, extendDown, sizeOf, LAYOUT_VERSION, type Sizes } from './layout'
import { adaptLayout, type Rects } from './adaptive'
import { useAdaptiveNodes } from './useAdaptiveNodes'
import { NativeComposerSeat } from './NativeComposer'
import { CanvasTools } from './CanvasTools'
import { CanvasMiniMap } from './CanvasMiniMap'
import { rasterPolicy, headerRasterScale } from './raster'
import { NativeTurnSeat } from './NativeTurn'
import { useNodePending, NativeInteractionSeat, RunningStatus } from './NativeInteraction'
import { DEFAULT_CARD_SIZE, MIN_CARD_SIZE } from './cardSize'

const UI = createContext<any>(null)
const Interaction = createContext<any>(null)
const states = {
  preparing: '正在创建会话',
  sending: '等待回答',
  failed: '生成失败',
  stopped: '已停止',
  complete: '正在读取回答…',
}
const Body = React.memo(function Body({ n, text }: { n: Turn; text: string }) {
  return (
    <div className="st-md nodrag nopan nowheel" data-answer={n.id}>
      <Markdown
        remarkPlugins={[gfm, math]}
        rehypePlugins={[[katex, { output: 'mathml' }]]}
        skipHtml
      >
        {text}
      </Markdown>
    </div>
  )
})
function Answer({ study, n }) {
  const source = study.answerSource(n.id)
  const text = useSyncExternalStore(source.subscribe, source.getSnapshot)
  return <NativeTurnSeat study={study} node={n}><Body n={n} text={text || n.error || study.issues.get(n.id) ||
    (study.answers.has(n.id) && n.status === 'complete' ? '本轮没有文本回复' : states[n.status])} /></NativeTurnSeat>
}
function Composer({ id }) {
  const ui = useContext(UI)
  const node = ui.byId.get(id)
  const pending = useNodePending(ui.study, node)
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = ref.current, card = element?.closest<HTMLElement>('.st-card')
    if (!element || !card) return
    const observer = new ResizeObserver(() => card.style.setProperty('--st-composer-space', element.offsetHeight + 18 + 'px'))
    observer.observe(element)
    return () => { observer.disconnect(); card.style.removeProperty('--st-composer-space') }
  }, [])
  return <div ref={ref} className="st-card-composer">{pending
    ? <NativeInteractionSeat study={ui.study} node={node} />
    : node.endSeq == null ? <RunningStatus study={ui.study} node={node} />
    : <NativeComposerSeat study={ui.study} parent={node} />}</div>
}
function Card({ data, resizing: nodeResizing }) {
  const ui = useContext(UI),
    n: Turn = data.turn
  const interaction = useContext(Interaction)
  const active = n.id === ui.active
  const pending = useNodePending(ui.study, n)
  const customSize = ui.prefs.dimensions[n.id]
  const card = useRef<HTMLElement>(null)
  const header = useRef<HTMLElement>(null)
  const flowStore = useStoreApi()
  useEffect(() => {
    const body = card.current?.querySelector<HTMLElement>('.st-body')
    if (!body || n.endSeq !== null) return
    let pinned = true, frame = 0
    const scroll = () => { pinned = body.scrollHeight - body.clientHeight - body.scrollTop < 40 }
    const observer = new MutationObserver(() => {
      if (!pinned || frame) return
      frame = requestAnimationFrame(() => { frame = 0; if (pinned) body.scrollTop = body.scrollHeight })
    })
    body.addEventListener('scroll', scroll)
    observer.observe(body, { childList: true, subtree: true, characterData: true })
    return () => { observer.disconnect(); body.removeEventListener('scroll', scroll); cancelAnimationFrame(frame) }
  }, [n.id, n.endSeq])
  useLayoutEffect(() => {
    if (!card.current) return
    const observer = new ResizeObserver(([entry]) => {
      const size = entry.borderBoxSize?.[0]
      card.current?.style.setProperty('--st-card-height', (size?.blockSize || card.current.offsetHeight) + 'px')
      ui.measure(n.id, {
        width: size?.inlineSize || card.current.offsetWidth,
        height: size?.blockSize || card.current.offsetHeight,
      })
    })
    observer.observe(card.current)
    return () => observer.disconnect()
  }, [n.id, ui.measure])
  useLayoutEffect(() => {
    if (!header.current || !card.current) return
    headerRasterScale(header.current, flowStore.getState().transform[2])
    const observer = new ResizeObserver(() => card.current?.style.setProperty('--st-head-space', header.current.offsetHeight + 24 + 'px'))
    observer.observe(header.current)
    return () => observer.disconnect()
  }, [flowStore])
  return (
    <article
      ref={card}
      className={'st-card ' + (active ? 'active ' : '') + (customSize || nodeResizing ? 'sized ' : '') + (ui.pathIds.has(n.id) ? 'onpath' : '')}
      onClick={(event) => {
        if (event.target.closest('[data-answer]') && !window.getSelection()?.isCollapsed) return
        ui.pick(n)
      }}
    >
      <NodeResizer
        isVisible={active}
        minWidth={MIN_CARD_SIZE.width}
        minHeight={MIN_CARD_SIZE.height}
        onResizeStart={() => interaction.begin(n.id, 'resize')}
        onResizeEnd={(_, size) => interaction.finish(n.id, size)}
      />
      <Handle type="target" position={Position.Top} />
      <header className="st-card-head" ref={header}>
        <div className="st-grip">
        <span className="st-kind">
          {n.parentId ? <CornerDownRight size={13} /> : <GitBranch size={13} />}{' '}
          {n.parentId ? (n.anchor ? '引用追问' : '追问') : '学习起点'}
        </span>
        <h3 className="st-question nodrag nopan nowheel" title={n.question}>{n.question}</h3>
        {pending ? <span className="st-generating">{pending.kind === 'approval' ? '等待审批' : '等待回答'}</span>
          : n.status === 'sending' || n.status === 'preparing' ? <span className="st-generating">生成中</span> : null}
        <GripHorizontal className="st-drag-hint" size={14} aria-hidden />
        </div>
          {n.anchor && (
            <button
              className="st-quote nodrag"
              title={n.anchor.text}
              onClick={(e) => {
                e.stopPropagation()
                ui.back(n)
              }}
            >
              ↖ {n.anchor.text}
            </button>
          )}
      </header>
          <div className="st-answer-region">
          <div className="st-body nodrag nopan nowheel">
            <Answer study={ui.study} n={n} />
          </div>
          {n.versionOf && ui.byId.has(n.versionOf) && (
            <button
              className="st-fold nodrag"
              onClick={(e) => {
                e.stopPropagation()
                ui.focus(ui.byId.get(n.versionOf))
              }}
            >
              查看原问题 ↗
            </button>
          )}
          </div>
          {active && <Composer key={n.id} id={n.id} />}
      <Handle type="source" position={Position.Bottom} />
    </article>
  )
}
const nodeTypes = { turn: Card }
const emptyPrefs = () => ({
  tree: null,
  selected: {},
  drafts: {},
  expanded: {},
  positions: {},
  dimensions: {},
  layoutVersions: {},
  edgeStyle: 'curve',
  views: {},
  reader: true,
  width: 480,
  scroll: {},
})
const key = 'dsh-study-tree:view:v1'
function readPrefs() {
  try {
    const saved = { ...emptyPrefs(), ...JSON.parse(localStorage.getItem(key) || '{}') }
    if (saved.edgeStyle === 'straight') saved.edgeStyle = 'rounded-step'
    if (!saved.nativeFrameVersion) {
      saved.width = Math.max(480, saved.width)
      saved.nativeFrameVersion = 1
    }
    if (!saved.canvasVersion) {
      for (const [tree, view] of Object.entries(saved.views)) {
        if (view.zoom >= 0.6) continue
        const p = saved.positions[tree]?.[saved.selected[tree] || tree] || { x: 0, y: 0 }
        saved.views[tree] = { x: 40 - p.x, y: 52 - p.y, zoom: 1 }
      }
      saved.canvasVersion = 2
    }
    return saved
  } catch {
    return emptyPrefs()
  }
}

// React Flow owns live positions and measurements. Persist coordinates on pointer release.
function Canvas({
  nodes,
  edges,
  onCommit,
  interacting,
  onInit,
  view,
  onView,
  onBlank,
  focusCurrent,
  edgeStyle,
  onEdgeStyle,
  onArrange,
}) {
  const { display, onNodesChange, begin, finish } = useAdaptiveNodes(nodes, onCommit, interacting)
  const interaction = React.useMemo(() => ({ begin, finish }), [begin, finish])
  const canvas = useRef<HTMLDivElement>(null), layer = useRef<HTMLElement>(null)
  const raster = useRef(null)
  if (!raster.current) raster.current = rasterPolicy(() => {
    if (!layer.current?.isConnected) layer.current = canvas.current?.querySelector('.react-flow__viewport') || null
    return layer.current
  }, view.zoom, zoom => {
    for (const header of layer.current?.querySelectorAll<HTMLElement>('.st-card-head') || [])
      headerRasterScale(header, zoom)
  })
  return (
    <Interaction.Provider value={interaction}>
    <ReactFlow
      ref={canvas}
      proOptions={{ hideAttribution: true }}
      nodes={display}
      edges={edges}
      nodeTypes={nodeTypes}
      defaultViewport={view}
      onInit={onInit}
      onMoveStart={event => raster.current.start(event)}
      onMove={(_, view) => raster.current.change(view)}
      onMoveEnd={(_, view) => { raster.current.end(view); onView(view) }}
      onPaneClick={onBlank}
      onNodesChange={onNodesChange}
      onNodeDragStart={(_, node) => begin(node.id, 'drag')}
      onNodeDragStop={(_, node) => finish(node.id)}
      nodesConnectable={false}
      minZoom={0.28}
      maxZoom={1.65}
      deleteKeyCode={null}
    >
      <CanvasBackground />
      <CanvasMiniMap />
      <CanvasTools
        focusCurrent={focusCurrent}
        edgeStyle={edgeStyle}
        onEdgeStyle={onEdgeStyle}
        onArrange={onArrange}
      />
    </ReactFlow>
    </Interaction.Provider>
  )
}

export function StudyPage({ study, nativeFrame, nativeSessionKey }) {
  const [, redraw] = useReducer((v) => v + 1, 0),
    [prefs, setPrefs] = useState(readPrefs)
  const [selection, setSelection] = useState(null)
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(null)
  const lock = useRef(false),
    flow = useRef(null),
    root = useRef(null)
  const pendingFocus = useRef<string | null>(null)
  const [focusRevision, requestFocus] = useReducer(v => v + 1, 0)
  const [nativeRevision, retryNative] = useReducer(v => v + 1, 0)
  const roots = React.useMemo(() => study.nodes.filter((n) => !n.parentId), [study.nodes])
  const requested = study.nodes.find((node) => node.id === study.active)
  const treeId = requested?.treeId || roots.find((n) => n.id === prefs.tree)?.id || roots[0]?.id
  const turns = React.useMemo(
      () => study.nodes.filter((n) => n.treeId === treeId),
      [treeId, study.nodes],
    ),
    active = requested?.id || prefs.selected[treeId] || treeId
  const byId = React.useMemo(() => new Map(study.nodes.map((n) => [n.id, n])), [study.nodes]),
    path = React.useMemo(() => pathTo(study.nodes, active), [study.nodes, active]),
    pathIds = React.useMemo(() => new Set(path.map((n) => n.id)), [path])
  const patch = (props) => setPrefs((p) => ({ ...p, ...props }))
  const field = (name, id, value) =>
    setPrefs((p) => ({ ...p, [name]: { ...p[name], [id]: value } }))
  const select = (n) => {
    if (study.active !== n.id) {
      study.setActive(n.id)
      study.emit()
    }
    setPrefs((p) => ({ ...p, tree: n.treeId, selected: { ...p.selected, [n.treeId]: n.id } }))
  }
  const pick = (n) => {
    if (n.id !== active) {
      select(n)
      setSelection(null)
    }
  }
  useEffect(() => {
    const target = study.navigation
    if (!target) return
    study.navigation = null
    const node = study.nodes.find((item) => item.id === target.id)
    if (node) {
      select(node)
      pendingFocus.current = node.id
      requestFocus()
      setSelection(null)
    }
  }, [study.navigation])
  useEffect(() => {
    if (study.active !== active) {
      study.setActive(active)
      study.emit()
    }
  }, [active])
  const nativeSessionId = byId.get(active)?.sessionId
  useEffect(() => {
    if (nativeSessionId) study.showSession(nativeSessionId)
  }, [active, nativeSessionId, nativeRevision])
  useEffect(() => {
    study.hideReader = () => patch({ reader: false })
    return () => {
      study.hideReader = null
    }
  }, [study])
  const sizes = useRef<Sizes>({})
  const measured = useRef(new Set<string>())
  const interacting = useRef(false)
  for (const [id, size] of Object.entries(prefs.dimensions)) sizes.current[id] = size
  const layoutInput = useRef({ treeId, turns })
  layoutInput.current = { treeId, turns }
  const measure = React.useCallback((id, size) => {
    const first = !measured.current.has(id)
    measured.current.add(id)
    const previous = sizeOf(id, sizes.current)
    sizes.current[id] = size
    if (interacting.current || (!first && Math.abs(size.height - previous.height) < 1 && Math.abs(size.width - previous.width) < 1)) return
    setPrefs((current) => {
      const { treeId, turns } = layoutInput.current
      const stored = current.positions[treeId]
      if (!stored || current.layoutVersions[treeId] !== LAYOUT_VERSION) return current
      const base: Rects = Object.fromEntries(turns.filter(n => stored[n.id]).map(n => [n.id, {
        ...stored[n.id], ...(n.id === id ? previous : sizeOf(n.id, sizes.current)),
      }]))
      if (!base[id]) return current
      const positions = adaptLayout(base, id, { ...stored[id], ...size })
      return Object.keys(positions).every(id => positions[id].x === stored[id].x && positions[id].y === stored[id].y)
        ? current
        : {
            ...current,
            positions: { ...current.positions, [treeId]: positions },
          }
    })
  }, [])
  const positions = React.useMemo(
    () =>
      prefs.layoutVersions[treeId] === LAYOUT_VERSION
        ? extendDown(turns, prefs.positions[treeId] || {}, sizes.current)
        : arrange(turns, sizes.current),
    [treeId, turns.map((node) => node.id).join(), prefs.positions, prefs.layoutVersions],
  )
  const migrating = prefs.layoutVersions[treeId] !== LAYOUT_VERSION
  const initialView = migrating
    ? { x: 40 - (positions[active]?.x || 0), y: 52 - (positions[active]?.y || 0), zoom: 1 }
    : prefs.views[treeId] || { x: 40, y: 52, zoom: 1 }
  function autoArrange() {
    if (!treeId || !turns.length) return
    const positions = arrange(turns, sizes.current)
    setPrefs((current) => ({
      ...current,
      layoutVersions: { ...current.layoutVersions, [treeId]: LAYOUT_VERSION },
      positions: { ...current.positions, [treeId]: positions },
    }))
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        flow.current?.fitView({ padding: 0.15, maxZoom: 1, duration: 180 })
      }),
    )
  }
  useEffect(() => {
    study.listeners.add(redraw)
    const refresh = () => study.refresh().catch((e) => setError(e.message))
    void refresh()
    window.addEventListener('focus', refresh)
    return () => {
      study.listeners.delete(redraw)
      window.removeEventListener('focus', refresh)
    }
  }, [study])
  const device = useRef({ drafts: prefs.drafts, scroll: prefs.scroll })
  const latest = useRef(prefs)
  const timer = useRef(null)
  const flush = React.useCallback(() => {
    clearTimeout(timer.current)
    if (timer.current === null) return
    timer.current = null
    try {
      localStorage.setItem(key, JSON.stringify({ ...latest.current, ...device.current }))
    } catch {
      setError('阅读位置和草稿未能保存到此设备')
    }
  }, [])
  const schedule = React.useCallback(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, 220)
  }, [flush])
  useLayoutEffect(() => {
    latest.current = prefs
    schedule()
  }, [prefs, schedule])
  useEffect(() => {
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [flush])
  function saveDraft(id, value) {
    device.current.drafts[id] = value
    schedule()
  }
  useEffect(() => {
    study.observe(turns, path)
  }, [study, turns, path])
  useEffect(() => () => study.observe([], []), [study])
  useEffect(() => {
    if (!treeId || !turns.length) return
    if (migrating || turns.some((node) => !prefs.positions[treeId]?.[node.id])) {
      setPrefs((current) => ({
        ...current,
        positions: { ...current.positions, [treeId]: positions },
        layoutVersions: { ...current.layoutVersions, [treeId]: LAYOUT_VERSION },
        views: migrating ? { ...current.views, [treeId]: initialView } : current.views,
      }))
    }
  }, [treeId, turns.length, migrating])
  useEffect(() => {
    const id = pendingFocus.current
    if (!id || !positions[id] || !flow.current) return
    pendingFocus.current = null
    const { x, y } = positions[id]
    const size = sizeOf(id, sizes.current)
    flow.current.setCenter(x + size.width / 2, y + size.height / 2, {
      zoom: Math.max(0.92, flow.current.getZoom()),
      duration: 160,
    })
  }, [active, positions, focusRevision])

  useEffect(() => {
    const cancel = (e) => {
      if (e.key === 'Escape') {
        setSelection(null)
        root.current?.querySelector('.st-actions')?.removeAttribute('open')
      }
    }
    const dismissMenu = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest('.st-actions'))
        root.current?.querySelector('.st-actions[open]')?.removeAttribute('open')
    }
    window.addEventListener('keydown', cancel)
    document.addEventListener('pointerdown', dismissMenu, true)
    return () => {
      window.removeEventListener('keydown', cancel)
      document.removeEventListener('pointerdown', dismissMenu, true)
    }
  }, [])
  function focus(n) {
    select(n)
    const p = positions[n.id]
    if (n.treeId !== treeId) {
      pendingFocus.current = n.id
      return
    }
    const size = sizeOf(n.id, sizes.current)
    if (p) flow.current?.setCenter(p.x + size.width / 2, p.y + size.height / 2, { zoom: 1, duration: 160 })
  }
  function back(n) {
    const parent = byId.get(n.parentId)
    if (!parent) return
    focus(parent)
    study.turns.reveal.get(parent.id)?.()
    field('expanded', parent.id, true)
    requestAnimationFrame(() => {
      const body = root.current?.querySelector('.st-card [data-answer="' + parent.id + '"]')
      if (body && !locate(body, n.anchor)) setError('已返回来源节点，原句位置无法唯一确定')
    })
  }
  async function submit(parent, raw, anchor, versionOf?: string) {
    const prompt = raw.trim() || (anchor ? '请解释「' + anchor.text + '」' : '')
    if (!prompt || lock.current || (parent && parent.endSeq == null)) return
    lock.current = true
    setBusy(true)
    setError('')
    try {
      await study.submit(
        parent,
        prompt,
        anchor,
        versionOf,
      )
      if (!anchor && !versionOf) saveDraft(parent?.id || 'root', '')
    } catch (e) {
      setError(e.message)
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  function capture(e, context) {
    if (e.target.closest('.st-native-composer, .st-quote-popover, .st-selection-actions')) return
    const s = window.getSelection()
    if (!s?.rangeCount || s.isCollapsed) {
      if (!e.target.closest('.st-quote-popover')) setSelection(null)
      return
    }
    const range = s.getRangeAt(0),
      body = range.startContainer.parentElement?.closest('[data-answer]')
    if (!body || !nativeFrame.contains(body)) return
    if (byId.get(body.dataset.answer)?.endSeq == null) return
    const anchor = selectionAt(body, range)
    if (!anchor) return
    if (context) e.preventDefault()
    const rect = range.getBoundingClientRect(),
      bounds = nativeFrame.getBoundingClientRect()
    setSelection({
      id: body.dataset.answer,
      anchor,
      range: range.cloneRange(),
      mode: 'actions',
      focus: context,
      x: Math.max(8, Math.min(rect.left - bounds.left, bounds.width - 420)),
      y: Math.max(8, Math.min(rect.top - bounds.top - 44, bounds.height - 44)),
      branchY: Math.max(8, Math.min(rect.bottom - bounds.top + 8, bounds.height - 220)),
    })
  }
  useLayoutEffect(() => {
    // Native selection disappears when an input gains focus. A separate browser
    // highlight keeps the exact source range visible without taking focus back.
    const registry = CSS.highlights
    if (!registry || !window.Highlight) return
    registry.delete('study-tree-quote')
    if (selection?.range) registry.set('study-tree-quote', new Highlight(selection.range))
    return () => registry.delete('study-tree-quote')
  }, [selection])
  useEffect(() => {
    if (selection?.mode !== 'added') return
    const focus = () => {
      const input = nativeFrame.querySelector(`.react-flow__node[data-id="${CSS.escape(selection.id)}"] [data-study-composer="card"] [data-composer-input]`)
      if (!input) return false
      input.focus({ preventScroll: true })
      return true
    }
    if (focus()) return
    const observer = new MutationObserver(() => { if (focus()) observer.disconnect() })
    observer.observe(nativeFrame, { childList: true, subtree: true })
    const timer = setTimeout(() => observer.disconnect(), 5000)
    return () => { clearTimeout(timer); observer.disconnect() }
  }, [selection?.mode, selection?.id, nativeFrame])
  async function addSelection() {
    const current = selection, node = byId.get(current.id)
    if (!node) return
    setSelection({ ...current, mode: 'adding' })
    select(node)
    try {
      await study.composers.addToCard(node, current.anchor)
      setSelection(value => value?.range === current.range ? { ...value, mode: 'added' } : value)
    } catch (error) {
      setError(error.message)
      setSelection(value => value?.range === current.range ? { ...value, mode: 'actions' } : value)
    }
  }
  const nodes = React.useMemo(
    () =>
      turns.map((n) => ({
        id: n.id,
        type: 'turn',
        data: { turn: n },
        dragHandle: '.st-grip',
        position: positions[n.id],
        selected: n.id === active,
        style: prefs.dimensions[n.id] ? { ...prefs.dimensions[n.id] } : { ...DEFAULT_CARD_SIZE },
      })),
    [turns, positions, active, prefs.dimensions],
  )
  const edges = React.useMemo(
    () =>
      turns
        .filter((n) => n.parentId)
        .map((n) => ({
          id: n.id,
          source: n.parentId,
          target: n.id,
          type: prefs.edgeStyle === 'rounded-step' ? 'smoothstep' : 'default',
          pathOptions: { borderRadius: 12, offset: 24 },
          style: {
            stroke: pathIds.has(n.id) ? 'var(--st-edge-active)' : 'var(--st-edge)',
            strokeWidth: pathIds.has(n.id) ? 2.5 : 2,
            vectorEffect: 'non-scaling-stroke',
            strokeLinecap: 'round',
          },
        })),
    [turns, pathIds, prefs.edgeStyle],
  )
  function download(all) {
    const sorted = []
    function visit(n) {
      sorted.push(n)
      for (const c of turns.filter((c) => c.parentId === n.id)) visit(c)
    }
    if (all) visit(byId.get(treeId))
    const list = all ? sorted : path
    const md = list
      .map(
        (n) =>
          '## ' +
          n.question +
          '\n\n' +
          (all
            ? '路径：' +
              pathTo(turns, n.id)
                .map((p) => p.question)
                .join(' → ') +
              '\n\n'
            : '') +
          (n.anchor ? '> ' + n.anchor.text.replaceAll('\n', '\n> ') + '\n\n' : '') +
          (study.answers.get(n.id) || n.error || states[n.status]),
      )
      .join('\n\n---\n\n')
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = '学习树-' + (all ? '整树' : '当前路径') + '.md'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <UI.Provider
      value={{
        study,
        prefs,
        byId,
        active,
        pathIds,
        busy,
        measure,
        submit,
        pick,
        focus,
        back,
        expand: (id, v) => field('expanded', id, v),
        draft: (id) => device.current.drafts[id] || '',
        saveDraft,
      }}
    >
      <section
        className="st"
        ref={root}
        onMouseUp={(e) => {
          if (!e.target.closest('.st-quote-popover, .st-native-composer, .st-selection-actions')) capture(e, false)
        }}
        onContextMenuCapture={(e) => {
          if (e.target.closest('[data-answer]')) {
            capture(e, true)
            if (window.getSelection()?.toString()) e.stopPropagation()
          }
        }}
      >
        <main>
          <header className="st-bar">
            <button title="新建学习主题" aria-label="新建学习主题" onClick={() => study.open(null)}>
              <Plus size={17} />
            </button>
            <span className="st-title-icon">
              <GitBranch size={17} />
            </span>
            <strong>{byId.get(treeId)?.title || byId.get(treeId)?.question || '新学习树'}</strong>
            {treeId && (
              <details className="st-actions">
                <summary title="学习树操作" aria-label="学习树操作">
                  <Ellipsis size={18} />
                </summary>
                <section onClick={(e) => e.currentTarget.parentElement.removeAttribute('open')}>
                  <button
                    disabled={path.some((n) => !study.answers.has(n.id))}
                    onClick={() => download(false)}
                  >
                    导出当前路径
                  </button>
                  <button
                    disabled={turns.some((n) => !study.answers.has(n.id))}
                    onClick={() => download(true)}
                  >
                    导出整棵树
                  </button>
                  <button
                    onClick={() => {
                      study.enabled = false
                      study.emit()
                    }}
                  >
                    打开完整对话
                  </button>
                  <button
                    onClick={() =>
                      setEditing({
                        kind: 'name',
                        id: treeId,
                        text: byId.get(treeId)?.title || byId.get(treeId)?.question,
                      })
                    }
                  >
                    重命名学习树
                  </button>
                  <button
                    onClick={() =>
                      setEditing({ kind: 'question', id: active, text: byId.get(active)?.question })
                    }
                  >
                    {byId.get(active)?.parentId ? '改写问题' : '在新主题中改写根问题'}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      const n = byId.get(active)
                      void submit(byId.get(n.parentId), n.question, n.anchor, n.id)
                    }}
                  >
                    {byId.get(active)?.parentId ? '重新回答' : '在新主题中重新回答'}
                  </button>
                </section>
              </details>
            )}
            <button
              className="st-reader-switch"
              aria-label={prefs.reader ? '收起对话' : '显示对话'}
              title={prefs.reader ? '收起对话' : '显示对话'}
              onClick={() => patch({ reader: !prefs.reader })}
            >
              {prefs.reader ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
            </button>
          </header>
          {editing && (
            <form
              className="st-edit"
              onSubmit={async (e) => {
                e.preventDefault()
                const text = editing.text.trim(),
                  n = byId.get(editing.id)
                if (!text || !n) return
                if (editing.kind === 'name') {
                  try {
                    await study.save({ ...n, title: text })
                  } catch (err) {
                    setError(err.message)
                    return
                  }
                } else await submit(byId.get(n.parentId), text, n.anchor, n.id)
                setEditing(null)
              }}
            >
              <input
                autoFocus
                value={editing.text}
                aria-label={editing.kind === 'name' ? '学习树名称' : '改写的问题'}
                onChange={(e) => setEditing({ ...editing, text: e.target.value })}
              />
              <button disabled={busy}>确定</button>
              <button type="button" onClick={() => setEditing(null)}>
                取消
              </button>
            </form>
          )}
          {error || study.error ? (
            <div role="alert" className="st-error">
              {error || study.error}{' '}
              <button
                onClick={() => {
                  setError('')
                  void study.refresh().then(() => retryNative()).catch((e) => setError(e.message))
                }}
              >
                刷新
              </button>
            </div>
          ) : null}
          {treeId && (
            <Canvas
              key={treeId}
              nodes={nodes}
              edges={edges}
              onInit={(i) => {
                flow.current = i
                requestFocus()
              }}
              view={initialView}
              onView={(v) => field('views', treeId, v)}
              edgeStyle={prefs.edgeStyle}
              onEdgeStyle={(edgeStyle) => patch({ edgeStyle })}
              onArrange={autoArrange}
              focusCurrent={() => {
                const n = byId.get(active)
                if (n) focus(n)
              }}
              interacting={interacting}
              onCommit={(positions, resized) => setPrefs(current => ({
                ...current,
                positions: { ...current.positions, [treeId]: positions },
                dimensions: resized ? { ...current.dimensions, [resized.id]: { width: resized.width, height: resized.height } } : current.dimensions,
              }))}
              onBlank={() => {
                setSelection(null)
                const menu = root.current?.querySelector('.st-actions')
                menu?.removeAttribute('open')
              }}
            />
          )}
        </main>
        {prefs.reader && treeId && (
          <>
            <div
              className="st-split"
              role="separator"
              aria-label="调整对话区宽度"
              aria-orientation="vertical"
              tabIndex={0}
              onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
              onPointerMove={(e) => {
                if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
                const r = nativeFrame.getBoundingClientRect()
                nativeFrame.style.setProperty(
                  '--st-reader-width',
                  Math.max(248, Math.min(r.width * 0.58, r.right - e.clientX)) + 'px',
                )
              }}
              onLostPointerCapture={() => {
                const width = parseFloat(nativeFrame.style.getPropertyValue('--st-reader-width'))
                if (Number.isFinite(width)) patch({ width })
              }}
              onKeyDown={(e) => {
                if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
                  e.preventDefault()
                  patch({
                    width: Math.max(
                      248,
                      Math.min(
                        nativeFrame.clientWidth * 0.58,
                        prefs.width + (e.key === 'ArrowLeft' ? 20 : -20),
                      ),
                    ),
                  })
                }
              }}
            />
          </>
        )}
        <NativeBoundary
          study={study}
          path={path}
          frame={nativeFrame}
          sessionKey={nativeSessionKey}
          visible={prefs.reader}
          width={prefs.width}
          readingState={{
            position: device.current.scroll[active],
            onScroll: (position) => {
              device.current.scroll[active] = position
              schedule()
            },
          }}
          onQuote={(event) => capture(event, true)}
        />
        {selection && selection.mode !== 'added' &&
          createPortal(
            selection.mode !== 'branch' ? <div
              className="st-selection-actions nodrag nopan nowheel"
              role="toolbar"
              aria-label="选中文字操作"
              style={{ left: selection.x, top: selection.y }}
              onMouseDown={event => event.preventDefault()}
              onClick={event => event.stopPropagation()}
            >
              <button type="button" disabled={selection.mode === 'adding'} onClick={addSelection}>添加到对话</button>
              <button type="button" disabled={selection.mode === 'adding'} onClick={() => setSelection(value => ({ ...value, mode: 'branch', y: value.branchY, focus: true }))}>在分支中提问</button>
            </div> : <div
              className="st-quote-popover"
              role="dialog"
              aria-label="引用追问"
              style={{ left: selection.x, top: selection.y }}
            >
              <div className="st-quote-caption"><span>引用追问</span><button type="button" aria-label="取消引用追问" onClick={() => setSelection(null)}><X size={14} /></button></div>
              <NativeComposerSeat study={study} parent={byId.get(selection.id)} kind="quote" anchor={selection.anchor} focus={selection.focus} />
            </div>,
            nativeFrame,
          )}
      </section>
    </UI.Provider>
  )
}
