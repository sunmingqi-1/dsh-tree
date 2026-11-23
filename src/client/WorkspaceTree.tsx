import React, { useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { ChevronRight, GitBranch, Plus, PanelRightClose, Code2, FileText } from 'lucide-react'
import { pathTo } from './tree'
import { isFolded, setBranchFolds, useBranchFolds } from './branchFolds'
import { nodeMarks } from '../nodeMarks.js'

export function useStudy(study) {
  return useSyncExternalStore(
    (listener) => {
      study.listeners.add(listener)
      return () => study.listeners.delete(listener)
    },
    () => study.version,
  )
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
  const node = study.nodes.find((item) => !item.parentId && item.sessionId === sessionId)
  const folds = useBranchFolds()
  const rootRef = useRef<HTMLSpanElement>(null)
  const elected = !!node
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
  if (!elected) return null
  const turns = study.nodes.filter((item) => item.treeId === node.treeId)
  const children = new Map<string | null, typeof turns>()
  for (const turn of turns) {
    const rows = children.get(turn.parentId) || []
    rows.push(turn)
    children.set(turn.parentId, rows)
  }
  for (const rows of children.values()) rows.sort((a, b) => a.created - b.created)
  const selectedPath = new Set(pathTo(turns, study.active).map(turn => turn.id))
  function toggle(id, collapse) {
    if (collapse && children.get(id)?.some(child => selectedPath.has(child.id))) study.open(id)
    setBranchFolds([[id, 'both']], collapse, children)
  }
  function render(parent, depth) {
    return (children.get(parent) || []).map((turn) => {
      if (parent && isFolded(folds, selectedPath, turn)) return null
      const branches = children.get(turn.id)
      const hasChildren = !!branches?.length
      const expanded = hasChildren && branches.some(child => !isFolded(folds, selectedPath, child))
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
              value: { sessionId: turn.sessionId, displayTitle: turn.question, studyNodeId: turn.id },
            })}
          >
            <button
              className="st-tree-toggle"
              aria-label={(expanded ? '折叠：' : '展开：') + turn.question}
              disabled={!hasChildren}
              onClick={() => toggle(turn.id, expanded)}
            >
              {hasChildren ? (
                <ChevronRight size={13} style={{ rotate: expanded ? '90deg' : undefined }} />
              ) : turn.kind === 'code' ? <Code2 size={12} /> : turn.kind === 'markdown' ? <FileText size={12} /> : (
                <GitBranch size={12} />
              )}
            </button>
            {turn.mark && nodeMarks[turn.mark] && <span className="st-tree-mark"
              title={'节点颜色 · ' + nodeMarks[turn.mark].label}
              style={{ backgroundColor: nodeMarks[turn.mark].color }} />}
            <button
              className="st-tree-title"
              title={turn.question}
              onClick={() => study.open(turn.id)}
            >
              {turn.parentId ? turn.question : turn.title || turn.question}
            </button>
            {!turn.kind && turn.status === 'sending' && (
              <span className="st-tree-running" aria-label="正在回答" />
            )}
            <span className="st-tree-menu">
              {turn.sessionId &&
                renderFactorySlot('contextMenu.button', {
                  target: {
                    kind: 'session',
                    value: { sessionId: turn.sessionId, displayTitle: turn.question, studyNodeId: turn.id },
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
