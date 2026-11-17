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
// Each canonical root occupies one row in the native browser's projected list.
export function WorkspaceTree({
  study,
  sessionId,
  renderFactorySlot,
  useContextMenu,
}) {
  useStudy(study)
  const { getTriggerProps } = useContextMenu()
  const node = study.nodes.find((item) => item.sessionId === sessionId)
  const [folds, setFolds] = useState(savedFolds)
  const rootRef = useRef<HTMLSpanElement>(null)
  const elected = !!node && !node.parentId
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
  useEffect(() => {
    const update = () => setFolds(savedFolds())
    window.addEventListener('storage', update)
    window.addEventListener('study-tree-folds', update)
    return () => {
      window.removeEventListener('storage', update)
      window.removeEventListener('study-tree-folds', update)
    }
  }, [])
  if (!elected) return null
  const turns = study.nodes.filter((item) => item.treeId === node.treeId)
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
