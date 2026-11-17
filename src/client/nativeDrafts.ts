import type { Anchor, Turn } from './tree'

export const quoteText = (text: string) => text.replace(/\r\n?/g, '\n').split('\n').map(line => '> ' + line).join('\n')
export function nativeQuestion(text: string, anchor: Anchor | null) {
  const quote = anchor && quoteText(anchor.text)
  const linked = quote && text.includes(quote) ? anchor : null
  const question = (linked ? text.replace(quote, '') : text).trim()
  return { question: question || (linked ? '解释这段内容' : '阅读附件'), anchor: linked }
}

export class NativeDrafts {
  seats = new Map<HTMLElement, { key: string; parent: Turn; kind: 'card' | 'quote'; anchor: Anchor | null }>()
  sessions: Record<string, string> = (() => {
    try { return JSON.parse(localStorage.getItem('dsh-study-tree:composer-drafts') || '{}') } catch { return {} }
  })()
  private pending = new Map<string, Promise<string>>()
  private stops = new Set<() => void>()
  private accepting = new Set<string>()
  private migrated = (() => {
    try { return new Set<string>(JSON.parse(localStorage.getItem('dsh-study-tree:native-draft-migration') || '[]')) } catch { return new Set<string>() }
  })()
  private submissions: Record<string, Turn> = (() => {
    try { return JSON.parse(localStorage.getItem('dsh-study-tree:native-submissions') || '{}') } catch { return {} }
  })()
  constructor(readonly study: any) {}

  private persistSubmissions() {
    try { localStorage.setItem('dsh-study-tree:native-submissions', JSON.stringify(this.submissions)) } catch {}
  }
  private async record(node: Turn) {
    const existing = this.study.nodes.find(item => item.id === node.id)
    const saved = existing || await this.study.save(node)
    delete this.submissions[node.id]
    this.persistSubmissions()
    this.study.watch(saved)
    return saved
  }
  async recover() {
    for (const node of Object.values(this.submissions)) {
      try { await this.record(node) }
      catch { this.study.error = '问答已发送，节点暂未保存。请刷新后重试。' }
    }
  }

  private session(parent: Turn, kind: string, anchor: Anchor | null) {
    const key = JSON.stringify([parent.id, kind, anchor?.start, anchor?.text])
    if (this.pending.has(key)) return this.pending.get(key)!
    const task = (async () => {
      const sessions = this.study.ctx.sessions
      let id = this.sessions[key]
      if (sessions.list.getSnapshot().byId[id]) {
        const used = await sessions.using(id, { source: 'studyTree' }, async ref => {
          const binding = await ref.ready
          await binding.session.loadThrough(parent.endSeq)
          return binding.eventSource.getSnapshot().entries.some(({ event }) =>
            event.type === 'user/message' && event.seq > parent.endSeq,
          )
        })
        if (!used) return id
      }
      const source = this.study.readerTarget?.parentId === parent.id
        ? this.study.readerTarget.sessionId : parent.sessionId
      id = await sessions.fork({ sessionId: source, atSeq: parent.endSeq })
      this.sessions[key] = id
      try { localStorage.setItem('dsh-study-tree:composer-drafts', JSON.stringify(this.sessions)) } catch {}
      this.study.emit()
      return id
    })().finally(() => this.pending.delete(key))
    this.pending.set(key, task)
    return task
  }

  mount(request, ready: (reference: any) => void, failed: (message: string) => void) {
    const { parent, kind, anchor } = request
    if (parent.endSeq == null || !parent.sessionId) return () => {}
    let mounted = true, stopped = false, saving = false, reference, input, binding
    let offEvents = () => {}, offInput = () => {}
    const stop = () => {
      if (stopped) return
      stopped = true
      offEvents(); offInput(); reference?.release()
      this.stops.delete(stop)
    }
    const busy = () => saving || (input && input.state.getSnapshot().phase !== 'plain')
      || binding?.session.getSnapshot().pendingSubmissions.length > 0
    this.stops.add(stop)
    void this.session(parent, kind, anchor).then(async sessionId => {
      if (stopped) return
      reference = this.study.ctx.sessions.retain(sessionId, { source: 'studyTree' })
      binding = await reference.ready
      if (stopped) return
      input = this.study.ctx.conversation.input.for(binding.ctx)
      if (kind === 'card' && !this.migrated.has(parent.id)) {
        try {
          const legacy = JSON.parse(localStorage.getItem('dsh-study-tree:view:v1') || '{}').drafts?.[parent.id]
          if (legacy && !input.state.getSnapshot().draft.trim()) input.setDraft(legacy)
          this.migrated.add(parent.id)
          localStorage.setItem('dsh-study-tree:native-draft-migration', JSON.stringify([...this.migrated]))
        } catch {}
      }
      if (anchor && !input.state.getSnapshot().draft.trim()) input.insertQuote(anchor.text)
      const read = () => {
        if (stopped || saving) return
        const message = binding.eventSource.getSnapshot().entries.find(({ event }) =>
          event.type === 'user/message' && event.seq > parent.endSeq && event.data.source?.rpcId,
        )?.event
        if (!message) { if (!mounted && !busy()) stop(); return }
        if (this.study.nodes.some(n => n.sessionId === sessionId && n.requestId === message.data.source.rpcId)) { stop(); return }
        const submission = sessionId + ':' + message.data.source.rpcId
        if (this.accepting.has(submission)) return
        this.accepting.add(submission)
        saving = true
        request.sent = true
        this.study.emit()
        const text = message.data.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
        const node: Turn = {
          id: crypto.randomUUID(), treeId: parent.treeId, parentId: parent.id,
          ...nativeQuestion(text, anchor), created: Date.now(), sessionId,
          requestId: message.data.source.rpcId, endSeq: null, status: 'sending', error: null, revision: 0,
        }
        this.submissions[node.id] = node
        this.persistSubmissions()
        void this.record(node).then(node => {
          if (mounted) this.study.open(node.id)
        }).catch(() => { this.study.error = '问答已发送，节点暂未保存。请刷新后重试。'; this.study.emit() }).finally(() => { this.accepting.delete(submission); stop() })
      }
      offEvents = binding.eventSource.subscribe(read)
      offInput = input.state.subscribe(() => { if (!mounted) queueMicrotask(read) })
      if (mounted) ready(reference)
      read()
    }).catch(error => {
      if (mounted) failed(error.message)
      stop()
    })
    return () => {
      mounted = false
      // Let an accepted/in-flight native submission create its node even when
      // its card loses selection. Idle editors release their Session binding.
      if (!busy()) stop()
    }
  }
  dispose() { for (const stop of [...this.stops]) stop(); this.seats.clear() }
}
