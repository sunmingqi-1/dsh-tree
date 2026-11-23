import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, Eye, Code2, Copy, FileText, WrapText, X } from 'lucide-react'
import { FenceCodeBlock, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import Markdown from 'react-markdown'
import gfm from 'remark-gfm'
import math from 'remark-math'
import katex from 'rehype-katex'
import { LanguagePicker } from './LanguagePicker'
import { SourceEditor } from './SourceEditor'
import type { Study } from './study'
import { locate } from './selection'
import type { Anchor, Material } from './tree'

const labels = {
  copyLabel: '复制代码',
  copiedLabel: '已复制',
  toolbarLabels: { codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '关闭自动换行' },
}
const remarkPlugins = [gfm, math]
const rehypePlugins: React.ComponentProps<typeof Markdown>['rehypePlugins'] = [[katex, { output: 'mathml' }]]
export const MarkdownBody = React.memo(function MarkdownBody({ text }: { text: string }) {
  return <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} skipHtml>{text}</Markdown>
})

export const MaterialBody = React.memo(function MaterialBody({ material }: { material: Material }) {
  if (material.kind === 'code') return <div className="st-native-controls st-material-code">
    <FenceCodeBlock code={material.content} lang={material.language || undefined} labels={labels} streaming={false} diff={false} />
  </div>
  return <MarkdownBody text={material.content} />
})

export function MaterialIcon({ kind, size = 15 }: { kind: Material['kind']; size?: number }) {
  return kind === 'code' ? <Code2 size={size} aria-hidden /> : <FileText size={size} aria-hidden />
}

export function MaterialCard({ material, study, nodeActions, autoFocus }: {
  material: Material
  study: Study
  nodeActions: React.ReactNode
  autoFocus: boolean
}) {
  const drafts = study.materialDrafts
  const node = drafts.read(material)
  const [wrapped, setWrapped] = useState(true), [preview, setPreview] = useState(false)
  const [copied, setCopied] = useState('')
  const [, refresh] = React.useReducer(value => value + 1, 0)
  const isCode = node.kind === 'code', language = node.language || ''
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(''), 1400)
    return () => window.clearTimeout(timer)
  }, [copied])
  return <>
    <header className="st-material-bar st-grip" role="group" aria-label={isCode ? '代码块工具' : 'Markdown 工具'}>
      <div className="st-material-identity"><MaterialIcon kind={node.kind} />
        {isCode ? <LanguagePicker value={language} onChange={language => {
          drafts.edit(material, { language }); refresh()
        }} /> : 'Markdown'}
      </div>
      <div className="st-material-actions nodrag nopan">
        {isCode ? <>
          <button type="button" aria-label="自动换行" title="自动换行" aria-pressed={wrapped} onClick={() => setWrapped(!wrapped)}><WrapText size={15} /></button>
          <button type="button" aria-label="复制代码" title="复制代码" disabled={!node.content} onClick={async () => {
            setCopied(await writeClipboard(drafts.read(material).content) ? '已复制' : '复制失败')
          }}>{copied === '已复制' ? <Check size={15} /> : <Copy size={15} />}{copied && <span role="status">{copied}</span>}</button>
        </> : <button type="button" aria-pressed={preview} onClick={() => setPreview(!preview)}><Eye size={14} />预览</button>}
        {nodeActions}
      </div>
    </header>
    <div hidden={preview}><SourceEditor node={node} autoFocus={autoFocus} wrap={!isCode || wrapped}
      onChange={content => { drafts.edit(material, { content }); refresh() }} onCommit={() => drafts.commit(material)} /></div>
    {preview && <div className="st-material-rendered st-md nodrag nopan nowheel" data-answer={node.id}>
      <MarkdownBody text={node.content} />
    </div>}
  </>
}

export function MaterialHistory({ material, versionAnchor, onClose }: {
  material: Material
  versionAnchor?: Anchor | null
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null), previewRef = useRef<HTMLDivElement>(null)
  const titleId = React.useId()
  useLayoutEffect(() => {
    const dialog = ref.current
    dialog.showModal()
    return () => dialog.close()
  }, [])
  useEffect(() => {
    if (versionAnchor && previewRef.current) locate(previewRef.current, versionAnchor)
  }, [versionAnchor])
  return <dialog ref={ref} className="st-material-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose() }}>
    <div className="st-material-history">
      <header>
        <MaterialIcon kind={material.kind} size={18} />
        <h2 id={titleId}>提问时的资料 · 第 {material.revision} 版</h2>
        <button type="button" aria-label="关闭资料" onClick={onClose}><X size={17} /></button>
      </header>
      <strong>{material.question}</strong>
      <div ref={previewRef} className="st-md st-material-preview"><MaterialBody material={material} /></div>
      {versionAnchor && <blockquote className="st-material-excerpt">{versionAnchor.text}</blockquote>}
    </div>
  </dialog>
}
