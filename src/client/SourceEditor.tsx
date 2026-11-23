import React, { useLayoutEffect, useRef } from 'react'
import { Compartment, EditorState, Transaction } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, placeholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { StreamLanguage, syntaxHighlighting, HighlightStyle, indentOnInput } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { tags } from '@lezer/highlight'
import { c, cpp, csharp, java } from '@codemirror/legacy-modes/mode/clike'
import { javascript, json, typescript } from '@codemirror/legacy-modes/mode/javascript'
import { css } from '@codemirror/legacy-modes/mode/css'
import { go } from '@codemirror/legacy-modes/mode/go'
import { powerShell } from '@codemirror/legacy-modes/mode/powershell'
import { python } from '@codemirror/legacy-modes/mode/python'
import { rust } from '@codemirror/legacy-modes/mode/rust'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { standardSQL } from '@codemirror/legacy-modes/mode/sql'
import { html } from '@codemirror/legacy-modes/mode/xml'
import { yaml } from '@codemirror/legacy-modes/mode/yaml'
import type { Material } from './tree'

const modes = { c, cpp, csharp, java, javascript, json, typescript, css, go, powershell: powerShell,
  python, rust, bash: shell, sql: standardSQL, html, yaml }
const language = new Compartment(), wrapping = new Compartment()
const colors = HighlightStyle.define([
  { tag: [tags.keyword, tags.meta, tags.atom], class: 'st-token-keyword' },
  { tag: [tags.string, tags.special(tags.string)], class: 'st-token-string' },
  { tag: [tags.function(tags.variableName), tags.typeName, tags.number, tags.link], class: 'st-token-name' },
  { tag: tags.comment, class: 'st-token-comment' },
  { tag: [tags.heading, tags.strong], fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
])
function syntax(node: Material) {
  if (node.kind === 'markdown') return markdown()
  const mode = modes[node.language || '']
  return mode ? StreamLanguage.define(mode) : []
}

export function SourceEditor({ node, wrap, onChange, onCommit, autoFocus }: {
  node: Material; wrap: boolean; autoFocus: boolean
  onChange: (text: string) => void; onCommit: () => void
}) {
  const host = useRef<HTMLDivElement>(null), editor = useRef<EditorView>(null)
  const callbacks = useRef({ onChange, onCommit })
  callbacks.current = { onChange, onCommit }
  useLayoutEffect(() => {
    const view = new EditorView({ parent: host.current, doc: node.content, extensions: [
      history(), indentOnInput(), keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      node.kind === 'code' ? lineNumbers() : [],
      placeholder(node.kind === 'code' ? '粘贴或输入代码…' : '用 Markdown 写下笔记…'),
      syntaxHighlighting(colors), language.of(syntax(node)), wrapping.of(wrap ? EditorView.lineWrapping : []),
      EditorView.contentAttributes.of({ 'aria-label': node.kind === 'code' ? '代码编辑器' : 'Markdown 编辑器',
        'aria-multiline': 'true', 'data-answer': node.id, spellcheck: 'false' }),
      EditorState.transactionFilter.of(tr => tr.docChanged && tr.newDoc.length > 64000 ? [] : tr),
      EditorView.updateListener.of(update => {
        if (update.docChanged && !update.transactions.some(tr => tr.annotation(Transaction.remote)))
          callbacks.current.onChange(update.state.doc.toString())
      }),
      EditorView.domEventHandlers({ blur: () => { callbacks.current.onCommit() } }),
    ] })
    editor.current = view
    return () => { callbacks.current.onCommit(); view.destroy(); editor.current = null }
  }, [node.id])
  useLayoutEffect(() => {
    const view = editor.current
    if (view.state.doc.toString() !== node.content)
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: node.content },
        annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)] })
  }, [node.content])
  useLayoutEffect(() => { editor.current.dispatch({ effects: language.reconfigure(syntax(node)) }) }, [node.kind, node.language])
  useLayoutEffect(() => { editor.current.dispatch({ effects: wrapping.reconfigure(wrap ? EditorView.lineWrapping : []) }) }, [wrap])
  useLayoutEffect(() => { if (autoFocus) editor.current.focus() }, [autoFocus])
  return <div ref={host} className="st-source-editor nodrag nopan nowheel" onKeyDown={event => event.stopPropagation()} />
}
