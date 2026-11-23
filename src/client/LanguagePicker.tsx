import React, { useId, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'

const languages = [
  ['', '纯文本', 'text plain txt'], ['typescript', 'TypeScript', 'ts'], ['javascript', 'JavaScript', 'js'],
  ['python', 'Python', 'py'], ['cpp', 'C++'], ['c', 'C'], ['csharp', 'C#'], ['java', 'Java'],
  ['rust', 'Rust', 'rs'], ['go', 'Go', 'golang'], ['bash', 'Shell', 'sh'], ['powershell', 'PowerShell', 'ps1'],
  ['json', 'JSON'], ['yaml', 'YAML', 'yml'], ['html', 'HTML'], ['css', 'CSS'], ['sql', 'SQL'],
]

export function LanguagePicker({ value, onChange }: { value: string; onChange: (language: string) => void }) {
  const id = useId(), listId = id + '-list'
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null), current = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false), [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(value)
  const known = languages.find(([key]) => key === value)
  const options = known ? languages : [[value, value], ...languages]
  const search = query.trim().toLowerCase()
  const matches = options.filter(parts => parts.some(part => part.toLowerCase().includes(search)))
  const index = Math.max(0, matches.findIndex(([key]) => key === cursor))
  const optionId = (key: string) => listId + '-' + (key || 'plain-text')

  useLayoutEffect(() => {
    const element = panel.current
    const toggle = () => {
      const visible = element.matches(':popover-open')
      setOpen(visible)
      if (visible) {
        setQuery(''); setCursor(value)
        input.current?.focus({ preventScroll: true })
      }
    }
    element.addEventListener('toggle', toggle)
    return () => element.removeEventListener('toggle', toggle)
  }, [value])
  useLayoutEffect(() => {
    if (open) current.current?.scrollIntoView({ block: 'nearest' })
  }, [open, index, query])
  function choose(key: string) {
    if (key !== value) onChange(key)
    panel.current?.hidePopover()
    trigger.current?.focus({ preventScroll: true })
  }
  return <>
    <button type="button" ref={trigger} className="st-language-trigger nodrag nopan" aria-label="代码语言"
      aria-haspopup="dialog" aria-expanded={open} popovertarget={id}>
      {known?.[1] ?? value}<ChevronDown size={13} aria-hidden />
    </button>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label="选择代码语言"
      className="st-language-popup nodrag nopan nowheel"
      onClick={event => event.stopPropagation()}
      onKeyDown={event => {
        event.stopPropagation()
        if (event.nativeEvent.isComposing) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const next = index + (event.key === 'ArrowDown' ? 1 : -1)
          if (matches.length) setCursor(matches[(next + matches.length) % matches.length][0])
        } else if (event.key === 'Enter' && matches.length) {
          event.preventDefault(); choose(matches[index][0])
        } else if (event.key === 'Escape' || event.key === 'Tab') {
          if (event.key === 'Escape') event.preventDefault()
          panel.current?.hidePopover()
          trigger.current?.focus({ preventScroll: true })
        }
      }}>
      <label className="st-language-search">
        <Search size={15} aria-hidden />
        <input ref={input} type="text" role="combobox" aria-label="搜索语言" aria-autocomplete="list"
          aria-controls={listId} aria-expanded={open} aria-activedescendant={matches.length ? optionId(matches[index][0]) : undefined}
          placeholder="搜索语言…" value={query} onChange={event => { setQuery(event.target.value); setCursor(value) }}
          spellCheck={false} autoComplete="off" />
      </label>
      {open && <div className="st-language-list" id={listId} role="listbox" aria-label="代码语言">
        {matches.map(([key, label], i) => <div key={key} id={optionId(key)} role="option" aria-selected={key === value}
          ref={i === index ? current : undefined} data-current={i === index || undefined}
          onMouseDown={event => event.preventDefault()} onClick={() => choose(key)}>
          <span>{label}</span>{key === value && <Check size={15} aria-hidden />}
        </div>)}
      </div>}
      {open && !matches.length && <p role="status">没有匹配的语言</p>}
    </div>
  </>
}
