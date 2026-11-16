import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from 'react'
import { ReactFlow, Handle, Position, Background, Controls, useViewport } from '@xyflow/react'
import dagre from '@dagrejs/dagre'
import Markdown from 'react-markdown'
import gfm from 'remark-gfm'
import math from 'remark-math'
import katex from 'rehype-katex'
import { pathTo, type Anchor, type Turn } from './tree'
import { locate, selectionAt } from './selection'
import { Study } from './study'

const UI = createContext<any>(null)
const states = {
  preparing: '正在创建会话',
  sending: '等待回答',
  failed: '生成失败',
  stopped: '已停止',
  complete: '已完成',
}
function Body({ n, text }: { n: Turn; text: string }) {
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
}
function Composer({ id, root = false }) {
  const ui = useContext(UI)
  const draft = ui.prefs.drafts[id] || ''
  const send = () => ui.submit(root ? null : ui.byId.get(id), draft, null)
  return (
    <form
      className="st-composer nodrag nopan nowheel"
      onSubmit={(e) => {
        e.preventDefault()
        send()
      }}
    >
      <textarea
        aria-label={root ? '学习主题' : '继续追问'}
        placeholder={root ? '你想学习什么？' : '从这里继续追问…'}
        value={draft}
        onChange={(e) => ui.setDraft(id, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            e.preventDefault()
            send()
          }
        }}
      />
      <div>
        {root ? (
          <span>新学习树</span>
        ) : (
          <button
            type="button"
            className="st-add"
            aria-label="引用本轮回答"
            title="引用本轮回答"
            onClick={(e) => {
              const card = e.currentTarget.closest('.st-card'),
                body = card?.querySelector('[data-answer]')
              if (!body?.textContent || ui.byId.get(id)?.endSeq == null) return
              const r = new Range()
              r.selectNodeContents(body)
              const s = getSelection()
              s?.removeAllRanges()
              s?.addRange(r)
              body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
            }}
          >
            ＋
          </button>
        )}
        <button
          aria-label="发送问题"
          disabled={!draft.trim() || ui.busy || (!root && ui.byId.get(id)?.endSeq == null)}
        >
          ↑
        </button>
      </div>
    </form>
  )
}
function Card({ data }) {
  const ui = useContext(UI),
    n: Turn = data.turn
  const overview = useViewport().zoom < 0.55
  const active = n.id === ui.active
  const text = ui.study.answers.get(n.id) || ''
  const expanded = !!ui.prefs.expanded[n.id]
  const body = useRef(null),
    [long, setLong] = useState(false)
  useLayoutEffect(() => {
    if (body.current) setLong(body.current.scrollHeight > 118)
  }, [text, overview, expanded])
  return (
    <article
      className={'st-card ' + (active ? 'active ' : '') + (ui.pathIds.has(n.id) ? 'onpath' : '')}
      onClick={() => ui.pick(n)}
    >
      <Handle type="target" position={Position.Left} />
      <header className="st-grip">
        <span>{n.parentId ? (n.anchor ? '引用追问' : '追问') : '学习起点'}</span>
        <span>⠿</span>
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
            <Body n={n} text={text || n.error || ui.study.issues.get(n.id) || states[n.status]} />
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
          {active && <Composer id={n.id} />}
        </>
      )}
      <Handle type="source" position={Position.Right} />
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
  views: {},
  reader: true,
  width: 332,
  scroll: {},
})
const key = 'dsh-study-tree:view:v1'
function readPrefs() {
  try {
    return { ...emptyPrefs(), ...JSON.parse(localStorage.getItem(key) || '{}') }
  } catch {
    return emptyPrefs()
  }
}
function initialPositions(turns, stored) {
  const g = new dagre.graphlib.Graph()
    .setGraph({ rankdir: 'LR', ranksep: 88, nodesep: 84 })
    .setDefaultEdgeLabel(() => ({}))
  for (const n of turns) g.setNode(n.id, { width: 320, height: 475 })
  for (const n of turns) if (n.parentId) g.setEdge(n.parentId, n.id)
  dagre.layout(g)
  const positions = { ...stored }
  for (const n of turns) {
    if (positions[n.id]) continue
    const parent = positions[n.parentId],
      p = g.node(n.id)
    const next = parent ? { x: parent.x + 410, y: parent.y } : { x: p.x - 160, y: 0 }
    while (
      Object.values(positions).some(
        (q: any) => Math.abs(q.x - next.x) < 325 && Math.abs(q.y - next.y) < 475,
      )
    )
      next.y += 490
    positions[n.id] = next
  }
  return positions
}

export function StudyPage({ study }: { study: Study }) {
  const [, redraw] = useReducer((v) => v + 1, 0),
    [prefs, setPrefs] = useState(readPrefs)
  const [newTree, setNewTree] = useState(false),
    [library, setLibrary] = useState(false)
  const [selection, setSelection] = useState(null),
    [question, setQuestion] = useState('')
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(null)
  const lock = useRef(false),
    flow = useRef(null),
    root = useRef(null),
    reader = useRef(null)
  const pendingFocus = useRef<string | null>(null)
  const roots = study.nodes.filter((n) => !n.parentId)
  const treeId = newTree ? null : prefs.tree || roots[0]?.id
  const turns = study.nodes.filter((n) => n.treeId === treeId),
    active = prefs.selected[treeId] || treeId
  const byId = new Map(study.nodes.map((n) => [n.id, n])),
    path = pathTo(study.nodes, active),
    pathIds = new Set(path.map((n) => n.id))
  const patch = (props) => setPrefs((p) => ({ ...p, ...props }))
  const field = (name, id, value) =>
    setPrefs((p) => ({ ...p, [name]: { ...p[name], [id]: value } }))
  const select = (n) => {
    setNewTree(false)
    setPrefs((p) => ({ ...p, tree: n.treeId, selected: { ...p.selected, [n.treeId]: n.id } }))
  }
  const pick = (n) => {
    if (n.id !== active) {
      select(n)
      setSelection(null)
    }
  }
  const positions = React.useMemo(
    () => initialPositions(turns, prefs.positions[treeId] || {}),
    [treeId, turns.map((n) => n.id).join(), prefs.positions],
  )
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
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(prefs))
    } catch {
      setError('阅读位置和草稿未能保存到此设备')
    }
  }, [prefs])
  useEffect(() => {
    for (const n of turns) if (!study.issues.has(n.id)) study.watch(n)
  }, [treeId, study.nodes])
  useEffect(() => {
    if (treeId && turns.some((n) => !prefs.positions[treeId]?.[n.id]))
      field('positions', treeId, positions)
  }, [treeId, turns.length])
  useEffect(() => {
    const id = pendingFocus.current
    if (!id || !positions[id] || !flow.current) return
    pendingFocus.current = null
    const { x, y } = positions[id]
    flow.current.setCenter(x + 160, y + 150, { zoom: flow.current.getZoom(), duration: 180 })
  }, [active, positions])
  useLayoutEffect(() => {
    if (reader.current)
      reader.current.scrollTop = prefs.scroll[active] ?? reader.current.scrollHeight
  }, [active, prefs.reader])
  useEffect(() => {
    const cancel = (e) => {
      if (e.key === 'Escape') setSelection(null)
    }
    window.addEventListener('keydown', cancel)
    return () => window.removeEventListener('keydown', cancel)
  }, [])
  function focus(n) {
    select(n)
    const p = positions[n.id]
    if (n.treeId !== treeId) {
      pendingFocus.current = n.id
      return
    }
    if (p) flow.current?.setCenter(p.x + 160, p.y + 150, { zoom: 1, duration: 160 })
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
          setLibrary(false)
        },
        versionOf,
      )
      if (!anchor && !versionOf) field('drafts', parent?.id || 'root', '')
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
    if (!body || !root.current.contains(body)) return
    const anchor = selectionAt(body, range)
    if (!anchor) return
    if (context) e.preventDefault()
    const rect = range.getBoundingClientRect(),
      bounds = root.current.getBoundingClientRect()
    setSelection({
      id: body.dataset.answer,
      anchor,
      x: Math.max(8, Math.min(rect.left - bounds.left, bounds.width - 286)),
      y: Math.max(8, Math.min(rect.bottom - bounds.top + 6, bounds.height - 52)),
    })
    setQuestion('')
    if (context)
      requestAnimationFrame(() => root.current?.querySelector('.st-capsule input')?.focus())
  }
  const nodes = turns.map((n) => ({
    id: n.id,
    type: 'turn',
    data: { turn: n },
    dragHandle: '.st-grip',
    position: positions[n.id],
    selected: n.id === active,
  }))
  const edges = turns
    .filter((n) => n.parentId)
    .map((n) => ({
      id: n.id,
      source: n.parentId,
      target: n.id,
      type: 'smoothstep',
      style: { stroke: pathIds.has(n.id) ? 'var(--st-path)' : 'var(--st-line)' },
    }))
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
        submit,
        pick,
        focus,
        back,
        expand: (id, v) => field('expanded', id, v),
        setDraft: (id, v) => field('drafts', id, v),
      }}
    >
      <section
        className="st"
        ref={root}
        onMouseUp={(e) => {
          if (!e.target.closest('.st-capsule')) capture(e, false)
        }}
        onContextMenu={(e) => capture(e, true)}
      >
        <aside className={'st-library ' + (library ? 'open' : '')}>
          <header>
            学习树
            <button
              aria-label="新建学习树"
              onClick={() => {
                setNewTree(true)
                setLibrary(false)
                setSelection(null)
              }}
            >
              ＋
            </button>
          </header>
          {roots.map((n) => (
            <button
              key={n.id}
              className={treeId === n.id ? 'current' : ''}
              onClick={() => {
                setLibrary(false)
                setNewTree(false)
                patch({ tree: n.id })
                setSelection(null)
              }}
            >
              {n.title || n.question}
            </button>
          ))}
        </aside>
        <main>
          <header className="st-bar">
            <button className="st-directory" onClick={() => setLibrary(!library)}>
              目录
            </button>
            <strong>{byId.get(treeId)?.title || byId.get(treeId)?.question || '新学习树'}</strong>
            {treeId && (
              <details className="st-actions">
                <summary aria-label="学习树操作">···</summary>
                <section onClick={(e) => e.currentTarget.parentElement.removeAttribute('open')}>
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
            <button onClick={() => patch({ reader: !prefs.reader })}>
              {prefs.reader ? '收起阅读' : '路径阅读'}
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
          {!treeId ? (
            <div className="st-start">
              <div>
                <h2>从一个问题开始</h2>
                <Composer id="root" root />
              </div>
            </div>
          ) : (
            <ReactFlow
              key={treeId}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onInit={(i) => {
                flow.current = i
              }}
              defaultViewport={prefs.views[treeId] || { x: 36, y: 48, zoom: 0.86 }}
              onMoveEnd={(_, v) => field('views', treeId, v)}
              onNodeDrag={(_, n) =>
                field('positions', treeId, { ...positions, [n.id]: n.position })
              }
              onPaneClick={() => setSelection(null)}
              onNodeDragStop={(_, n) =>
                field('positions', treeId, { ...positions, [n.id]: n.position })
              }
              nodesConnectable={false}
              minZoom={0.28}
              maxZoom={1.65}
              deleteKeyCode={null}
            >
              <Background gap={22} size={1} />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
        </main>
        {prefs.reader && treeId && (
          <>
            <div
              className="st-split"
              role="separator"
              aria-label="调整阅读区宽度"
              aria-orientation="vertical"
              tabIndex={0}
              onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
              onPointerMove={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId))
                  patch({
                    width: Math.max(
                      248,
                      Math.min(
                        root.current.clientWidth * 0.58,
                        root.current.getBoundingClientRect().right - e.clientX,
                      ),
                    ),
                  })
              }}
              onKeyDown={(e) => {
                if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
                  e.preventDefault()
                  patch({
                    width: Math.max(
                      248,
                      Math.min(
                        root.current.clientWidth * 0.58,
                        prefs.width + (e.key === 'ArrowLeft' ? 20 : -20),
                      ),
                    ),
                  })
                }
              }}
            />
            <aside className="st-reader" style={{ width: prefs.width }}>
              <header>
                <strong>路径阅读</strong>
                <button aria-label="隐藏路径阅读" onClick={() => patch({ reader: false })}>
                  ›
                </button>
              </header>
              <nav>
                {path.map((n, i) => (
                  <React.Fragment key={n.id}>
                    {i > 0 && ' › '}
                    <button onClick={() => focus(n)}>{n.question}</button>
                  </React.Fragment>
                ))}
              </nav>
              <div
                className="st-chat"
                ref={reader}
                onScroll={(e) => field('scroll', active, e.currentTarget.scrollTop)}
              >
                {path.map((n) => (
                  <section key={n.id}>
                    <div className="st-user">{n.question}</div>
                    <div className="st-agent">
                      <header>
                        Agent<button onClick={() => focus(n)}>定位 ↗</button>
                      </header>
                      <Body
                        n={n}
                        text={
                          study.answers.get(n.id) ||
                          n.error ||
                          study.issues.get(n.id) ||
                          states[n.status]
                        }
                      />
                    </div>
                  </section>
                ))}
              </div>
              <footer>
                <button
                  onClick={() => download(false)}
                  disabled={path.some((n) => !study.answers.has(n.id))}
                >
                  导出路径
                </button>
                <button
                  onClick={() => download(true)}
                  disabled={turns.some((n) => !study.answers.has(n.id))}
                >
                  导出整树
                </button>
              </footer>
            </aside>
          </>
        )}
        {selection && (
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
              ↑
            </button>
          </form>
        )}
      </section>
    </UI.Provider>
  )
}
