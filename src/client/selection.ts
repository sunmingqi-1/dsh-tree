import type { Anchor } from './tree'

export function selectionAt(body: HTMLElement, range: Range): Anchor | null {
  if (range.collapsed || !body.contains(range.commonAncestorContainer)) return null
  const before = range.cloneRange()
  before.selectNodeContents(body)
  before.setEnd(range.startContainer, range.startOffset)
  const start = before.toString().length
  const text = range.toString()
  if (!text.trim()) return null
  const source = body.textContent ?? ''
  return {
    text,
    start,
    prefix: source.slice(Math.max(0, start - 32), start),
    suffix: source.slice(start + text.length, start + text.length + 32),
  }
}

export function locate(body: HTMLElement, anchor: Anchor) {
  const text = body.textContent ?? ''
  let offset = anchor.start
  if (!text.startsWith(anchor.text, offset) || !text.slice(0, offset).endsWith(anchor.prefix)) {
    const key = anchor.prefix + anchor.text + anchor.suffix
    const first = text.indexOf(key)
    if (first < 0 || first !== text.lastIndexOf(key)) return false
    offset = first + anchor.prefix.length
  }
  const end = offset + anchor.text.length
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode(),
    index = 0
  const range = new Range()
  while (node) {
    const after = index + (node.textContent?.length ?? 0)
    if (offset >= index && offset < after) range.setStart(node, offset - index)
    if (end > index && end <= after) {
      range.setEnd(node, end - index)
      node.parentElement?.scrollIntoView({ block: 'nearest' })
      const registry = (CSS as any).highlights
      if (registry) {
        const h = new (window as any).Highlight(range)
        registry.set('study-tree-source', h)
        setTimeout(() => {
          if (registry.get('study-tree-source') === h) registry.delete('study-tree-source')
        }, 2500)
      } else {
        const s = getSelection()
        s?.removeAllRanges()
        s?.addRange(range)
      }
      return true
    }
    index = after
    node = walker.nextNode()
  }
  return false
}
