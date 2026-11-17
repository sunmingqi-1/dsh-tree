import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ChevronRight, GitBranch, Plus, PanelRightClose } from 'lucide-react'
import { pathTo } from './tree'

export function useStudy(study) {
  return useSyncExternalStore(
    (listener) => {
      study.listeners.add(listener)
      return () => study.listeners.delete(listener)
    },
    () => study.version,
  )
}

function savedFolds() {
  try {
    return JSON.parse(localStorage.getItem('dsh-study-tree:folds') || '{}')
  } catch {
    return {}
  }
}

// The native browser owns grouping, search, sorting, and ordinary Session rows.
// Elect one visible row per learning tree so native row paging cannot hide its root.
export function WorkspaceTree({
  study,
  sessionId,
  representatives,
  renderFactorySlot,
  useContextMenu,
  useSessions,
}) {
  useStudy(study)
  const sessions = useSessions((state) => state)
  const { getTriggerProps } = useContextMenu()
  const node = study.nodes.find((item) => item.sessionId === sessionId)
  const workspaces = study.ctx.workspaces.list.getSnapshot().items
  const groupOf = (treeId) => {
    const root = study.nodes.find((item) => item.id === treeId)
    return (
      workspaces.find((workspace) => workspace.sessionIds.includes(root?.sessionId))?.workspaceId ||
      ''
    )
  }
  const group = node ? groupOf(node.treeId) : ''
  const [folds, setFolds] = useState(savedFolds)
  const rootRef = useRef<HTMLSpanElement>(null)
  const elected = !!node && representatives.get(group)?.values().next().value === sessionId
  useLayoutEffect(() => {
    const row = rootRef.current?.closest<HTMLElement>('[data-row-key]')
    if (!elected || !row) return
    const attributes = ['role', 'tabindex', 'draggable'].map((name) => [
      name,
      row.getAttribute(name),
    ])
    row.setAttribute('role', 'presentation')
    row.tabIndex = -1
    row.draggable = false
    return () => {
      for (const [name, value] of attributes) {
        if (value === null) row.removeAttribute(name)
        else row.setAttribute(name, value)
      }
    }
  }, [elected])
  useLayoutEffect(() => {
    if (!node) return
    let members = representatives.get(group)
    if (!members) representatives.set(group, (members = new Set()))
    members.add(sessionId)
    study.emit()
    return () => {
      members.delete(sessionId)
      if (!members.size) representatives.delete(group)
      study.emit()
    }
  }, [!!node, group, sessionId])
  useEffect(() => {
    const update = () => setFolds(savedFolds())
    window.addEventListener('storage', update)
    window.addEventListener('study-tree-folds', update)
    return () => {
      window.removeEventListener('storage', update)
      window.removeEventListener('study-tree-folds', update)
    }
  }, [])
  if (!node) return [...Object.values(study.readerDrafts), ...Object.values(study.composers.sessions)].includes(sessionId) ? <span className="st-tree-member" /> : null
  if (representatives.get(group)?.values().next().value !== sessionId)
    return <span className="st-tree-member" />
  const trees = new Set(
    study.nodes
      .filter((item) => !item.parentId && groupOf(item.id) === group)
      .map((item) => item.id),
  )
  const turns = study.nodes.filter((item) => trees.has(item.treeId))
  const workspaceState = study.ctx.workspaces.list.getSnapshot()
  const members = group
    ? workspaceState.items.find((workspace) => workspace.workspaceId === group)?.sessionIds || []
    : sessions.ids.filter(
        (id) => !workspaceState.items.some((workspace) => workspace.sessionIds.includes(id)),
      )
  const learningSessions = new Set(study.nodes.map((item) => item.sessionId))
  const hasOtherSessions = members.some(
    (id) =>
      !learningSessions.has(id) &&
      sessions.byId[id]?.blank === false &&
      !workspaceState.archivedSessionIds.includes(id),
  )
  const children = new Map<string | null, typeof turns>()
  for (const turn of turns) {
    const rows = children.get(turn.parentId) || []
    rows.push(turn)
    children.set(turn.parentId, rows)
  }
  for (const rows of children.values()) rows.sort((a, b) => a.created - b.created)
  const ancestors = new Set(
    pathTo(turns, study.active)
      .slice(0, -1)
      .map((item) => item.id),
  )
  function toggle(id) {
    const next = { ...folds, [id]: !(folds[id] && !ancestors.has(id)) }
    // A selected descendant stays accessible. Explicit collapse selects its parent.
    if (ancestors.has(id)) {
      next[id] = true
      study.open(id)
    }
    localStorage.setItem('dsh-study-tree:folds', JSON.stringify(next))
    setFolds(next)
    window.dispatchEvent(new Event('study-tree-folds'))
  }
  function render(parent, depth) {
    return (children.get(parent) || []).map((turn) => {
      const hasChildren = children.has(turn.id)
      const expanded = hasChildren && (!folds[turn.id] || ancestors.has(turn.id))
      return (
        <React.Fragment key={turn.id}>
          <div
            className={'st-tree-row ' + (study.active === turn.id ? 'selected' : '')}
            role="treeitem"
            aria-level={depth + 1}
            aria-selected={study.active === turn.id}
            aria-expanded={hasChildren ? expanded : undefined}
            style={{ paddingLeft: 6 + depth * 15 }}
            {...getTriggerProps({
              kind: 'session',
              value: { sessionId: turn.sessionId, displayTitle: turn.question },
            })}
          >
            <button
              className="st-tree-toggle"
              aria-label={(expanded ? '折叠：' : '展开：') + turn.question}
              disabled={!hasChildren}
              onClick={() => toggle(turn.id)}
            >
              {hasChildren ? (
                <ChevronRight size={13} style={{ rotate: expanded ? '90deg' : undefined }} />
              ) : (
                <GitBranch size={12} />
              )}
            </button>
            <button
              className="st-tree-title"
              title={turn.question}
              onClick={() => study.open(turn.id)}
            >
              {turn.parentId ? turn.question : turn.title || turn.question}
            </button>
            {turn.status === 'sending' && (
              <span className="st-tree-running" aria-label="正在回答" />
            )}
            <span className="st-tree-menu">
              {turn.sessionId &&
                renderFactorySlot('contextMenu.button', {
                  target: {
                    kind: 'session',
                    value: { sessionId: turn.sessionId, displayTitle: turn.question },
                  },
                  label: '节点操作：' + turn.question,
                })}
            </span>
          </div>
          {expanded && render(turn.id, depth + 1)}
        </React.Fragment>
      )
    })
  }
  return (
    <span
      className="st-native-tree"
      ref={rootRef}
      role="tree"
      aria-label="学习主题"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      onDragStart={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      {!hasOtherSessions && (
        <style>{'[data-row-key="overflow:' + CSS.escape(group) + '"]{display:none}'}</style>
      )}
      {render(null, 0)}
    </span>
  )
}

export function NewStudyButton({ study, sessionId }) {
  useStudy(study)
  return (
    <>
      <button
        className="st-native-new"
        title="新建学习主题"
        aria-label="新建学习主题"
        onClick={() => {
          study.workspaceId = study.workspaceFor(sessionId)
          study.open(null)
        }}
      >
        <Plus size={16} />
      </button>
      {study.enabled && (
        <button
          className="st-native-new"
          title="隐藏对话面板"
          aria-label="隐藏对话面板"
          onClick={() => study.hideReader?.()}
        >
          <PanelRightClose size={16} />
        </button>
      )}
    </>
  )
}
