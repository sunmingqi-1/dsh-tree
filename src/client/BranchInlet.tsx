import React from 'react'
import { Minus } from 'lucide-react'
import { branchName, isQuoteBranch, type Turn } from './tree'

export function BranchInlet({ turn, onClick }: { turn: Turn; onClick: () => void }) {
  const name = '收起分支：' + branchName(turn)
  return <button type="button" className="st-inlet nodrag nopan"
    data-inlet={isQuoteBranch(turn) ? 'quote' : 'card'} aria-expanded="true"
    aria-label={name} title={name}
    onDoubleClick={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); onClick() }}>
    <Minus size={12} aria-hidden />
  </button>
}
