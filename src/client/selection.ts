import type { Anchor } from './tree'
import { EditorView } from '@codemirror/view'

// Native status/tool controls are siblings of the answer. Anchor offsets use
// only selectable Assistant Markdown, so expanding tools never moves a quote.
function answerNodes(body: HTMLElement): Text[] {
  const native = [...body.querySelectorAll<HTMLElement>('.st-native-row[data-chat-flow-kind="assistant-step"] [data-text-interaction-source]')]
  const roots = native.length ? native : body.querySelector('.st-turn-flow') ? [] : [body]
  const nodes: Text[] = []
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: node => node.parentElement?.closest('button, [hidden], [inert], [data-text-interaction-exclude], .katex, .sr-only, script, style')
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    })
    let node: Node
    while ((node = walker.nextNode())) nodes.push(node as Text)
  }
  return nodes
}

export function selectionAt(body: HTMLElement, range: Range): Anchor | null {
  if (range.collapsed || !body.contains(range.commonAncestorContainer)) return null
  const editor = body.classList.contains('cm-content') && EditorView.findFromDOM(body)
  if (editor) {
    const start = editor.posAtDOM(range.startContainer, range.startOffset)
    const end = editor.posAtDOM(range.endContainer, range.endOffset)
    const doc = editor.state.doc, text = doc.sliceString(start, end)
    return text.trim() ? { start, text, prefix: doc.sliceString(Math.max(0, start - 32), start),
      suffix: doc.sliceString(end, Math.min(doc.length, end + 32)) } : null
  }
  const nodes = answerNodes(body)
  if (!nodes.some(node => node === range.startContainer || range.startContainer.contains(node)) ||
      !nodes.some(node => node === range.endContainer || range.endContainer.contains(node))) return null
  const before = range.cloneRange()
  before.selectNodeContents(body)
  before.setEnd(range.startContainer, range.startOffset)
  let start = 0
  for (const node of nodes) {
    if (before.comparePoint(node, 0) > 0) continue
    start += before.comparePoint(node, node.length) <= 0 ? node.length
      : before.endContainer === node ? before.endOffset : 0
  }
  const text = range.toString()
  if (!text.trim()) return null
  const source = nodes.map(node => node.textContent).join('')
  if (source.slice(start, start + text.length) !== text) return null
  return {
    text,
    start,
    prefix: source.slice(Math.max(0, start - 32), start),
    suffix: source.slice(start + text.length, start + text.length + 32),
  }
}

export function locate(body: HTMLElement, anchor: Anchor) {
  const editor = body.classList.contains('cm-content') && EditorView.findFromDOM(body)
  if (editor) {
    const end = anchor.start + anchor.text.length
    if (end > editor.state.doc.length || editor.state.doc.sliceString(anchor.start, end) !== anchor.text) return false
    editor.dispatch({ selection: { anchor: anchor.start, head: end }, effects: EditorView.scrollIntoView(anchor.start, { y: 'center' }) })
    editor.focus()
    return true
  }
  const nodes = answerNodes(body)
  const text = nodes.map(node => node.textContent).join('')
  let offset = anchor.start
  if (!text.startsWith(anchor.text, offset) || !text.slice(0, offset).endsWith(anchor.prefix)) {
    const key = anchor.prefix + anchor.text + anchor.suffix
    const first = text.indexOf(key)
    if (first < 0 || first !== text.lastIndexOf(key)) return false
    offset = first + anchor.prefix.length
  }
  const end = offset + anchor.text.length
  let index = 0
  const range = new Range()
  for (const node of nodes) {
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
  }
  return false
}
