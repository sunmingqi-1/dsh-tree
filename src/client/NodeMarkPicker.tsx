import React, { useId, useRef, useState } from 'react'
import { Check, Palette, Slash } from 'lucide-react'
import { nodeMarks } from '../nodeMarks.js'
import type { Turn } from './tree'

export function NodeMarkPicker({ mark, onChange }: {
  mark: Turn['mark']
  onChange: (value: Turn['mark']) => void
}) {
  const id = useId()
  const panel = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const [showChoices, setShowChoices] = useState(false)
  const selected = mark && nodeMarks[mark]
  const choose = (next: Turn['mark']) => {
    panel.current?.hidePopover()
    button.current?.focus({ preventScroll: true })
    if ((mark ?? null) !== next) onChange(next)
  }
  return <div className="st-mark-picker nodrag nopan" onClick={event => event.stopPropagation()}>
    <button ref={button} type="button" popovertarget={id} className="st-mark-trigger" onClick={() => setShowChoices(true)}
      aria-label={'节点颜色 · ' + (selected?.label || '未标记')} title="标记节点颜色">
      {selected ? <i style={{ background: selected.color }} /> : <Palette size={14} />}
    </button>
    <div ref={panel} id={id} popover="auto" className="st-mark-palette nowheel" role="group" aria-label="选择节点颜色"
      onToggle={event => setShowChoices(event.currentTarget.matches(':popover-open'))}>
      {showChoices && <>
        <button type="button" aria-label="清除颜色" title="清除颜色" aria-pressed={!selected} onClick={() => choose(null)}>
          <Slash size={14} />
        </button>
        {Object.entries(nodeMarks).map(([key, entry]) =>
          <button key={key} type="button" aria-label={entry.label} title={entry.label} aria-pressed={key === mark}
            onClick={() => choose(key as Turn['mark'])}>
            <i style={{ background: entry.color }}>{mark === key && <Check size={12} />}</i>
          </button>)}
      </>}
    </div>
  </div>
}
