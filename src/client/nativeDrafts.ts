import type { Anchor, Turn } from './tree'
import { bindBranchInput } from './branchPrompt'
export { quoteText, nativeQuestion } from '../treeLog.js'

function stored(key: string) {
  try { return JSON.parse(localStorage.getItem('dsh-study-tree:' + key) || '{}') }
  catch { return {} }
}

export class NativeDrafts {
  seats = new Map<HTMLElement, any>()
  home: HTMLElement | null = null
  readerNode: string | null = null
  readerVisible = true
  // Existing fork-era draft sessions remain hidden in the native workspace.
  sessions = stored('composer-drafts')
  private attachments = new Map<string, string[]>()
  private deferredQuotes = new Map<string, Anchor>()
  private editor: any
  private stops = new Set<() => void>()
  private listeners = new Set<() => void>()
  private version = 0
  constructor(readonly study: any) {}
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  getSnapshot = () => this.version
  emit() { this.version++; for (const listener of this.listeners) listener() }

  async addToCard(parent: Turn, anchor: Anchor) {
    if (this.editor?.parentId === parent.id && this.editor.kind === 'card')
      this.editor.insert(anchor)
    else this.deferredQuotes.set(parent.id, anchor)
  }

  mount(request, ready, failed) {
    const { parent, kind, anchor } = request
    if (!parent.logged || parent.endSeq == null) {
      failed(parent.logged ? '请等待来源回答结束' : '旧版学习树仅支持阅读。请新建学习主题继续。')
      return () => {}
    }
    const key = JSON.stringify([parent.id, kind, anchor?.start, anchor?.text])
    const ref = this.study.ctx.sessions.retain(parent.sessionId, { source: 'studyTree.input' })
    let alive = true, released = false, off = () => {}, unbind = () => {}, input, editor
    const release = () => {
      if (released) return
      released = true
      off()
      unbind()
      ref.release()
      this.stops.delete(stop)
      if (this.editor === editor) this.editor = null
    }
    const stop = () => {
      alive = false
      if (released) return
      if (!editor) release()
      else if (!editor.busy()) editor.close()
    }
    this.stops.add(stop)
    void ref.ready.then(binding => {
      if (!alive) return
      input = this.study.ctx.conversation.input.for(binding.ctx)
      const busy = () => !['plain', 'claimed'].includes(input.state.getSnapshot().phase)
      const install = () => {
        if (!alive || busy()) return
        off()
        const draftKey = 'draft:' + key
        const existing = stored(draftKey)
        // Temporarily lend the Session shell to exactly one card or quote.
        const outside = input.draftSnapshot
        const outsideAttachments = [...input.state.getSnapshot().attachmentIds]
        const replace = (draft, attachments) => {
          for (const id of [...input.state.getSnapshot().attachmentIds]) input.removeAttachment(id)
          input.setDraft(draft || '')
          if (attachments?.length) input.addAttachments(attachments)
        }
        replace(existing?.draft, this.attachments.get(key))
        let source = existing?.anchor ?? anchor
        if (existing.draft === undefined && anchor) input.insertQuote(anchor.text)
        const remember = () => {
          try {
            localStorage.setItem('dsh-study-tree:' + draftKey, JSON.stringify({ draft: input.draftSnapshot, anchor: source }))
          } catch {}
          this.attachments.set(key, [...input.state.getSnapshot().attachmentIds])
        }
        const close = () => {
          off()
          remember()
          replace(outside, outsideAttachments)
          release()
        }
        editor = { parentId: parent.id, kind, close, busy, insert: a => {
          if (busy() || input.insertQuote(a.text) === false) throw new Error('引用未能加入输入框，请重试')
          source = a
          remember()
        } }
        this.editor = editor
        if (kind === 'card' && this.deferredQuotes.has(parent.id)) {
          editor.insert(this.deferredQuotes.get(parent.id))
          this.deferredQuotes.delete(parent.id)
        }
        unbind = bindBranchInput(this.study, binding, parent.sessionId, () => {
          const current = this.study.nodes.find(n => n.id === parent.id) || parent
          const id = crypto.randomUUID()
          return { parentSeq: current.boundarySeq ?? current.endSeq,
            metadata: { studyTree: { id, ...(source && { anchor: source }) } },
            onRequest: this.study.onSubmission(id),
          }
        })
        remember()
        off = input.state.subscribe(() => {
          if (!alive && !busy()) { queueMicrotask(() => { if (!released) close() }); return }
          remember()
        })
        ready(ref)
      }
      // The previous input transaction owns the shell through draft settlement.
      // Recheck after its cleanup microtask before installing the next draft.
      if (busy() || this.editor) {
        const retry = () => queueMicrotask(() => { if (!this.editor) install() })
        off = input.state.subscribe(retry)
        retry()
      } else install()
    }).catch(error => { if (alive) failed(error.message); stop() })
    return stop
  }
  dispose() {
    for (const stop of this.stops) stop()
    this.seats.clear()
    this.listeners.clear()
  }
}
