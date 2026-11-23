import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Panel, useReactFlow, useStore } from '@xyflow/react'
import { Plus, Minus, LocateFixed, Scan, Network, ListTree, ChevronDown, Check } from 'lucide-react'
import { MaterialIcon } from './MaterialCard'
import { materialLabel } from '../material.js'
import type { Material } from './tree'

function LineIcon({ rounded }) {
  return <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={rounded ? 'M3 4h5a2 2 0 0 1 2 2v8a2 2 0 0 0 2 2h5' : 'M3 4c11 0 3 12 14 12'} />
    <circle cx="3" cy="4" r="1.5" /><circle cx="17" cy="16" r="1.5" />
  </svg>
}

function EdgeMenu({ value, onChange }) {
  const [open, setOpen] = useState(false), [position, setPosition] = useState({ left: 0, top: 0 })
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null)
  const options = [{ value: 'curve', label: '曲线' }, { value: 'rounded-step', label: '圆角折线' }]
  const close = (restore = false) => { setOpen(false); if (restore) trigger.current?.focus() }
  const show = (last = false) => {
    const rect = trigger.current.getBoundingClientRect()
    setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 176)), top: Math.max(8, rect.top - 98) })
    setOpen(true)
    requestAnimationFrame(() => {
      const items = menu.current?.querySelectorAll<HTMLButtonElement>('button')
      items?.[last ? items.length - 1 : Math.max(0, options.findIndex(option => option.value === value))]?.focus()
    })
  }
  useEffect(() => {
    if (!open) return
    const outside = event => { if (!menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) close() }
    const dismiss = () => close()
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', dismiss)
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', dismiss) }
  }, [open])
  return <>
    <button ref={trigger} className="st-edge-trigger" aria-label="连线方式" aria-haspopup="menu" aria-expanded={open}
      onClick={() => open ? close() : show()}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(event.key === 'ArrowUp') }
      }}>
      <LineIcon rounded={value === 'rounded-step'} /><span>{value === 'rounded-step' ? '圆角折线' : '曲线'}</span><ChevronDown size={13} />
    </button>
    {open && createPortal(<div ref={menu} className="st-edge-popup" role="menu" aria-label="连线方式选项" style={position}
      onKeyDown={event => {
        const items = [...menu.current.querySelectorAll<HTMLButtonElement>('button')]
        const current = items.indexOf(document.activeElement as HTMLButtonElement)
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
          items[index]?.focus()
        } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) }
        else if (event.key === 'Tab') {
          event.preventDefault()
          const buttons = [...trigger.current.closest('.st-canvas-tools').querySelectorAll<HTMLButtonElement>('button')]
          buttons[(buttons.indexOf(trigger.current) + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus()
          close()
        }
      }}>
      {options.map(option => <button key={option.value} role="menuitemradio" aria-checked={value === option.value}
        onClick={() => { onChange(option.value); close(true) }}>
        <LineIcon rounded={option.value === 'rounded-step'} /><span>{option.label}</span>{value === option.value ? <Check size={14} /> : <i />}
      </button>)}
    </div>, document.body)}
  </>
}

function AddCardMenu({ onAdd }: { onAdd: (kind: Material['kind']) => void }) {
  const id = React.useId()
  const popup = useRef<HTMLDivElement>(null)
  return <>
    <button type="button" className="st-layout-action st-add-card" aria-label="添加卡片" title="添加卡片" popovertarget={id}>
      <Plus size={16} aria-hidden /><span>添加卡片</span>
    </button>
    <div ref={popup} id={id} popover="auto" className="st-edge-popup st-add-card-popup" role="group" aria-label="选择卡片类型">
      {(['markdown', 'code'] as const).map((kind, index) => <button key={kind} type="button" autoFocus={index === 0}
        onClick={() => { popup.current?.hidePopover(); onAdd(kind) }}>
        <MaterialIcon kind={kind} />{materialLabel(kind)}卡片
      </button>)}
    </div>
  </>
}

export function CanvasTools({ focusCurrent, edgeStyle, onEdgeStyle, onArrange, onExpandAll, hiddenCount, onAddCard }) {
  const flow = useReactFlow(), zoom = useStore(s => Math.round(s.transform[2] * 100))
  return <Panel position="bottom-center" className="st-canvas-tools" role="toolbar" aria-label="画布工具">
    <div className="st-zoom-group">
      <button aria-label="缩小" title="缩小" onClick={() => flow.zoomOut({ duration: 120 })}><Minus size={16} /></button>
      <button className="st-zoom-value" title="恢复 100% 缩放" onClick={() => flow.zoomTo(1, { duration: 120 })}>{zoom}%</button>
      <button aria-label="放大" title="放大" onClick={() => flow.zoomIn({ duration: 120 })}><Plus size={16} /></button>
    </div>
    <i className="st-tool-divider" />
    {onAddCard && <AddCardMenu onAdd={onAddCard} />}
    <EdgeMenu value={edgeStyle} onChange={onEdgeStyle} />
    <button className="st-layout-action" aria-label="自动布局" title="自动布局" onClick={onArrange}><Network size={16} /><span>自动布局</span></button>
    <button className="st-layout-action" aria-label="展开全部" disabled={!hiddenCount}
      title={hiddenCount ? `展开 ${hiddenCount} 个隐藏节点并重新布局` : '所有节点均已展开'}
      onClick={onExpandAll}><ListTree size={16} aria-hidden /><span>展开全部</span></button>
    <i className="st-tool-divider" />
    <button aria-label="定位当前节点" title="定位当前节点" onClick={focusCurrent}><LocateFixed size={17} /></button>
    <button aria-label="查看整棵树" title="查看整棵树" onClick={() => flow.fitView({ padding: 0.12, maxZoom: 1, duration: 180 })}><Scan size={17} /></button>
  </Panel>
}
