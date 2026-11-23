import React from 'react'
import { Minus, Plus } from 'lucide-react'
import type { Direction } from './branchFolds'
import { branchName, type CanvasNode } from './tree'

interface BranchOutletProps {
  direction: Direction
  count: number
  branches: CanvasNode[]
  visible: ReadonlySet<string>
  counts: ReadonlyMap<string, Record<Direction, number>>
  onToggle: (collapse: boolean) => void
  onRestore: (child: CanvasNode) => void
}

export function BranchOutlet({ direction, count, branches, visible, counts, onToggle, onRestore }: BranchOutletProps) {
  if (!branches.length) return null
  const hidden = branches.filter(child => !visible.has(child.id))
  const folded = hidden.length === branches.length
  const kind = direction === 'quote' ? '划词分支' : '卡片追问'
  const label = (folded ? '展开' : '折叠') + kind + '（' + count + ' 个节点）'
  return <div className="st-outlet-group nodrag nopan" data-outlet={direction} data-folded={folded || undefined}
    onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
    <button type="button" className="st-outlet" data-outlet={direction} aria-expanded={!folded}
      aria-label={label} title={label} onClick={() => onToggle(!folded)}>
      {folded ? <><Plus size={13} aria-hidden /><span>{count}</span></> : <Minus size={13} aria-hidden />}
    </button>
    {!folded && hidden.length > 0 && (
      <div className="st-hidden-branches nowheel" role="group" aria-label={'已收起的' + kind}>
        {hidden.map(child => {
          const nested = counts.get(child.id)
          const size = 1 + (nested ? nested.card + nested.quote : 0)
          const name = '展开分支：' + branchName(child)
          return <button key={child.id} type="button" aria-label={name} aria-expanded="false"
            title={name + '（' + size + ' 个节点）'} onClick={() => onRestore(child)}>
            <Plus size={12} aria-hidden /><span>{size}</span>
          </button>
        })}
      </div>
    )}
  </div>
}
