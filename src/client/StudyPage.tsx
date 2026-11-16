import { createPortal } from 'react-dom'
import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from 'react'
import {
  GitBranch,
  CornerDownRight,
  PanelRightOpen,
  PanelRightClose,
  Plus,
  Minus,
  Scan,
  LocateFixed,
  ArrowUp,
  Ellipsis,
  GripHorizontal,
  Network,
  ArrowUpRight,
} from 'lucide-react'
import {
  ReactFlow,
  Handle,
  Position,
  Panel,
  useStore,
  useReactFlow,
  useNodesState,
} from '@xyflow/react'
import Markdown from 'react-markdown'
import gfm from 'remark-gfm'
import math from 'remark-math'
import katex from 'rehype-katex'
import { pathTo, type Anchor, type Turn } from './tree'
import { locate, selectionAt } from './selection'
import { Study } from './study'
import { NativeBoundary } from './NativeFrame'
import { CanvasBackground } from './CanvasBackground'
import { arrange, extendDown, makeRoom, sizeOf, LAYOUT_VERSION, type Sizes } from './layout'

const UI = createContext<any>(null)
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
function Composer({ id }) {
  const ui = useContext(UI)
  const [draft, setDraft] = useState(() => ui.draft(id))
  const send = () => ui.submit(ui.byId.get(id), draft, null)
  return (
    <form
      className="st-composer nodrag nopan nowheel"
      onSubmit={(e) => {
        e.preventDefault()
        send()
      }}
    >
      <textarea
        aria-label="继续追问"
        placeholder="从这里继续追问…"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          ui.saveDraft(id, e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            e.preventDefault()
            send()
          }
        }}
      />
      <div>
        <button
          type="button"
          className="st-add"
          aria-label="引用本轮回答"
          title="引用本轮回答"
          onClick={(e) => {
            const card = e.currentTarget.closest('.st-card')
            ui.expand(id, true)
            requestAnimationFrame(() => {
              const body = card?.querySelector('[data-answer]')
              if (!body?.textContent || ui.byId.get(id)?.endSeq == null) return
              const r = new Range()
              r.selectNodeContents(body)
              const s = getSelection()
              s?.removeAllRanges()
              s?.addRange(r)
              body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
            })
          }}
        >
          <Plus size={17} />
        </button>
        <button
          aria-label="发送问题"
          disabled={!draft.trim() || ui.busy || ui.byId.get(id)?.endSeq == null}
        >
          <ArrowUp size={16} />
        </button>
      </div>
    </form>
  )
}
function Card({ data }) {
  const ui = useContext(UI),
    n: Turn = data.turn
  const overview = useStore((s) => s.transform[2] < 0.6)
  const active = n.id === ui.active
  const text = ui.study.answers.get(n.id) || ''
  const expanded = !!ui.prefs.expanded[n.id]
  const excerpt = React.useMemo(() => {
    if (expanded || text.length < 1600) return text
    // Keep the first Markdown blocks intact. The expanded card and reader use the source text.
    const preview = text.slice(0, 1600)
    const cut = preview.indexOf('\n\n', 600)
    return cut > 0 ? preview.slice(0, cut) : preview
  }, [expanded, text])
  const card = useRef<HTMLElement>(null)
  const body = useRef(null),
    [long, setLong] = useState(false)
  useLayoutEffect(() => {
    if (overview || !card.current) return
    const observer = new ResizeObserver(([entry]) => {
      const size = entry.borderBoxSize?.[0]
      ui.measure(n.id, {
        width: size?.inlineSize || card.current.offsetWidth,
        height: size?.blockSize || card.current.offsetHeight,
      })
    })
    observer.observe(card.current)
    return () => observer.disconnect()
  }, [n.id, overview, ui.measure])
  useLayoutEffect(() => {
    if (body.current) setLong(excerpt !== text || body.current.scrollHeight > 118)
  }, [text, excerpt, overview, expanded])
  return (
    <article
      ref={card}
      className={'st-card ' + (active ? 'active ' : '') + (ui.pathIds.has(n.id) ? 'onpath' : '')}
      onClick={() => ui.pick(n)}
    >
      <Handle type="target" position={Position.Top} />
      <header className="st-grip">
        <span>
          {n.parentId ? <CornerDownRight size={13} /> : <GitBranch size={13} />}{' '}
          {n.parentId ? (n.anchor ? '引用追问' : '追问') : '学习起点'}
        </span>
        <GripHorizontal size={15} aria-hidden />
      </header>
      <h3 className="nodrag">{n.question}</h3>
      {!overview && (
        <>
          {n.anchor && (
            <button
              className="st-quote nodrag"
              onClick={(e) => {
                e.stopPropagation()
                ui.back(n)
              }}
            >
              ↖ {n.anchor.text}
            </button>
          )}
          <div ref={body} className={'st-body ' + (expanded ? 'expanded' : '')}>
            <Body
              n={n}
              text={
                excerpt ||
                n.error ||
                ui.study.issues.get(n.id) ||
                (ui.study.answers.has(n.id) && n.status === 'complete'
                  ? '本轮没有文本回复'
                  : states[n.status])
              }
            />
          </div>
          {text && long && (
            <button className="st-fold nodrag" onClick={() => ui.expand(n.id, !expanded)}>
              {expanded ? '收起回答' : '展开回答'}
            </button>
          )}
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
          {n.error && text && <small>{n.error}</small>}
          {active && <Composer key={n.id} id={n.id} />}
        </>
      )}
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
function CanvasTools({ focusCurrent, edgeStyle, onEdgeStyle, onArrange }) {
  const flow = useReactFlow()
  const zoom = useStore((s) => Math.round(s.transform[2] * 100))
  return (
    <Panel position="bottom-center" className="st-canvas-tools">
      <button aria-label="缩小" onClick={() => flow.zoomOut({ duration: 120 })}>
        <Minus size={15} />
      </button>
      <button title="恢复 100% 缩放" onClick={() => flow.zoomTo(1, { duration: 120 })}>
        {zoom}%
      </button>
      <button aria-label="放大" onClick={() => flow.zoomIn({ duration: 120 })}>
        <Plus size={15} />
      </button>
      <i />
      <select
        aria-label="连线方式"
        title="连线方式"
        value={edgeStyle}
        onChange={(event) => onEdgeStyle(event.target.value)}
      >
        <option value="curve">曲线</option>
        <option value="rounded-step">圆角折线</option>
      </select>
      <button
        className="st-layout-action"
        aria-label="自动布局"
        title="自动布局"
        onClick={onArrange}
      >
        <Network size={15} />
        <span>自动布局</span>
      </button>
      <i />
      <button aria-label="定位当前节点" title="定位当前节点" onClick={focusCurrent}>
        <LocateFixed size={16} />
      </button>
      <button
        aria-label="查看整棵树"
        title="查看整棵树"
        onClick={() => flow.fitView({ padding: 0.12, maxZoom: 1, duration: 180 })}
      >
        <Scan size={16} />
      </button>
    </Panel>
  )
}

// React Flow owns live positions and measurements. Persist coordinates on pointer release.
function Canvas({
  nodes,
  edges,
  onDropNode,
  onInit,
  view,
  onView,
  onBlank,
  focusCurrent,
  edgeStyle,
  onEdgeStyle,
  onArrange,
}) {
  const [display, setDisplay, onNodesChange] = useNodesState(nodes)
  useEffect(() => {
    setDisplay((current) => {
      const previous = new Map(current.map((node) => [node.id, node]))
      // Retain measured dimensions and active dragging across external data/layout updates.
      return nodes.map((node) => {
        const retained = previous.get(node.id)
        return {
          ...retained,
          ...node,
          position: retained?.dragging ? retained.position : node.position,
        }
      })
    })
  }, [nodes, setDisplay])
  return (
    <ReactFlow
      proOptions={{ hideAttribution: true }}
      nodes={display}
      edges={edges}
      nodeTypes={nodeTypes}
      defaultViewport={view}
      onInit={onInit}
      onMoveEnd={(_, v) => onView(v)}
      onPaneClick={onBlank}
      onNodesChange={onNodesChange}
      onNodeDragStop={(_, node) => onDropNode(node)}
      nodesConnectable={false}
      minZoom={0.28}
      maxZoom={1.65}
      deleteKeyCode={null}
    >
      <CanvasBackground />
      <CanvasTools
        focusCurrent={focusCurrent}
        edgeStyle={edgeStyle}
        onEdgeStyle={onEdgeStyle}
        onArrange={onArrange}
      />
    </ReactFlow>
  )
}

export function StudyPage({ study, nativeFrame, nativeSessionKey }) {
  const [, redraw] = useReducer((v) => v + 1, 0),
    [prefs, setPrefs] = useState(readPrefs)
  const [selection, setSelection] = useState(null),
    [question, setQuestion] = useState('')
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(null)
  const lock = useRef(false),
    flow = useRef(null),
    root = useRef(null)
  const pendingFocus = useRef<string | null>(null)
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
      study.active = n.id
      study.emit()
    }
    setPrefs((p) => ({ ...p, tree: n.treeId, selected: { ...p.selected, [n.treeId]: n.id } }))
  }
  const pick = (n) => {
    if (flow.current?.getZoom() < 0.6) focus(n)
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
      setSelection(null)
    }
  }, [study.navigation])
  useEffect(() => {
    if (study.active !== active) {
      study.active = active
      study.emit()
    }
  }, [active])
  const nativeSessionId = byId.get(active)?.sessionId
  useEffect(() => {
    if (nativeSessionId) study.showSession(nativeSessionId)
  }, [nativeSessionId])
  useEffect(() => {
    study.hideReader = () => patch({ reader: false })
    return () => {
      study.hideReader = null
    }
  }, [study])
  const sizes = useRef<Sizes>({})
  const layoutInput = useRef({ treeId, turns })
  layoutInput.current = { treeId, turns }
  const measure = React.useCallback((id, size) => {
    const previous = sizeOf(id, sizes.current)
    sizes.current[id] = size
    if (size.height <= previous.height + 1) return
    setPrefs((current) => {
      const { treeId, turns } = layoutInput.current
      const stored = current.positions[treeId]
      if (!stored || current.layoutVersions[treeId] !== LAYOUT_VERSION) return current
      const positions = makeRoom(turns, stored, sizes.current, id)
      return positions === stored
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
    flow.current.setCenter(x + 170, y + 150, {
      zoom: Math.max(0.92, flow.current.getZoom()),
      duration: 160,
    })
  }, [active, positions])

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
    if (p) flow.current?.setCenter(p.x + 170, p.y + 150, { zoom: 1, duration: 160 })
  }
  function back(n) {
    const parent = byId.get(n.parentId)
    if (!parent) return
    focus(parent)
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
        (n) => {
          pendingFocus.current = n.id
          select(n)
          setSelection(null)
        },
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
    const s = window.getSelection()
    if (!s?.rangeCount || s.isCollapsed) {
      if (!e.target.closest('.st-capsule')) setSelection(null)
      return
    }
    const range = s.getRangeAt(0),
      body = range.startContainer.parentElement?.closest('[data-answer]')
    if (!body || !nativeFrame.contains(body)) return
    const anchor = selectionAt(body, range)
    if (!anchor) return
    if (context) e.preventDefault()
    const rect = range.getBoundingClientRect(),
      bounds = nativeFrame.getBoundingClientRect()
    setSelection({
      id: body.dataset.answer,
      anchor,
      x: Math.max(8, Math.min(rect.left - bounds.left, bounds.width - 286)),
      y: Math.max(8, Math.min(rect.bottom - bounds.top + 6, bounds.height - 52)),
    })
    setQuestion('')
    if (context)
      requestAnimationFrame(() => nativeFrame.querySelector('.st-capsule input')?.focus())
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
      })),
    [turns, positions, active],
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
          style: { stroke: pathIds.has(n.id) ? 'var(--st-path)' : 'var(--st-line)' },
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
          if (!e.target.closest('.st-capsule')) capture(e, false)
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
                    改写问题
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      const n = byId.get(active)
                      void submit(byId.get(n.parentId), n.question, n.anchor, n.id)
                    }}
                  >
                    重新回答
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
                  void study.refresh().catch((e) => setError(e.message))
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
              onDropNode={(n) => field('positions', treeId, { ...positions, [n.id]: n.position })}
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
        {selection &&
          createPortal(
            <form
              className="st-capsule"
              style={{ left: selection.x, top: selection.y }}
              onSubmit={(e) => {
                e.preventDefault()
                void submit(byId.get(selection.id), question, selection.anchor)
              }}
            >
              <input
                placeholder="添加可选问题…"
                aria-label="引用追问"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault()
                }}
              />
              <button
                disabled={busy || byId.get(selection.id)?.endSeq == null}
                aria-label="发送引用追问"
              >
                <ArrowUp size={16} />
              </button>
            </form>,
            nativeFrame,
          )}
      </section>
    </UI.Provider>
  )
}
