import { isUserPrompt, type Anchor, type Turn } from './tree'

export const quoteText = (text: string) => text.replace(/\r\n?/g, '\n').split('\n').map(line => '> ' + line).join('\n')
export function nativeQuestion(text: string, anchor: Anchor | null) {
  const quote = anchor && quoteText(anchor.text)
  const linked = quote && text.includes(quote) ? anchor : null
  const question = (linked ? text.replace(quote, '') : text).trim()
  return { question: question || (linked ? '解释这段内容' : '阅读附件'), anchor: linked }
}

export class NativeDrafts {
  seats = new Map<HTMLElement, { key: string; parent: Turn; kind: 'card' | 'quote'; anchor: Anchor | null }>()
  private listeners = new Set<() => void>()
  private version = 0
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  getSnapshot = () => this.version
  emit() { this.version++; for (const listener of this.listeners) listener() }
  private quotePools = new Map<string, any>()
  private quotePoolRefs = new Set<any>()
  private quoteAttachments = new Map<string, readonly string[]>()
  private quoteDrafts: Record<string, any> = (() => {
    try { return JSON.parse(localStorage.getItem('dsh-study-tree:quote-drafts') || '{}') } catch { return {} }
  })()
  sessions: Record<string, string> = (() => {
    try { return JSON.parse(localStorage.getItem('dsh-study-tree:composer-drafts') || '{}') } catch { return {} }
  })()
  private pending = new Map<string, Promise<string>>()
  private cardQuotes: Record<string, Anchor> = (() => {
    try { return JSON.parse(localStorage.getItem('dsh-study-tree:card-quotes') || '{}') } catch { return {} }
  })()
  async addToCard(parent: Turn, anchor: Anchor) {
    const sessionId = await this.session(parent, 'card', null)
    await this.study.ctx.sessions.using(sessionId, { source: 'studyTree' }, async reference => {
      const binding = await reference.ready
      const input = this.study.ctx.conversation.input.for(binding.ctx)
      if (input.state.getSnapshot().phase !== 'plain') throw new Error('请等待当前提问发送完成后再添加引用')
      if (input.insertQuote(anchor.text) === false) throw new Error('引用未能加入输入框，请重试')
      this.cardQuotes[sessionId] = anchor
      try { localStorage.setItem('dsh-study-tree:card-quotes', JSON.stringify(this.cardQuotes)) } catch {}
    })
  }
  private stops = new Set<() => void>()
  private accepting = new Set<string>()
  private migrated = (() => {
    try { return new Set<string>(JSON.parse(localStorage.getItem('dsh-study-tree:native-draft-migration') || '[]')) } catch { return new Set<string>() }
  })()
  private submissions: Record<string, Turn> = (() => {
    try { return JSON.parse(localStorage.getItem('dsh-study-tree:native-submissions') || '{}') } catch { return {} }
  })()
  constructor(readonly study: any) {}

  private acquireQuote(parent: Turn) {
    let pool = this.quotePools.get(parent.id)
    const busy = pool?.input && (pool.used || pool.input.state.getSnapshot().phase !== 'plain'
      || pool.binding.session.getSnapshot().pendingSubmissions.length > 0)
    if (!pool || busy) {
      if (busy) delete this.sessions[JSON.stringify([parent.id, 'quote', undefined, undefined])]
      pool = { users: 0, closed: false, reference: null, input: null, binding: null, anchorKey: null }
      const current = pool
      pool.close = () => {
        if (current.closed) return
        current.closed = true
        current.reference?.release()
        this.quotePoolRefs.delete(current)
        if (this.quotePools.get(parent.id) === current) this.quotePools.delete(parent.id)
      }
      this.quotePools.set(parent.id, pool)
      this.quotePoolRefs.add(pool)
      pool.ready = this.session(parent, 'quote', null).then(async sessionId => {
        if (current.closed) throw new Error('划词输入已关闭')
        current.reference = this.study.ctx.sessions.retain(sessionId, { source: 'studyTree' })
        current.binding = await current.reference.ready
        if (current.closed) throw new Error('划词输入已关闭')
        current.input = this.study.ctx.conversation.input.for(current.binding.ctx)
        return current
      }).catch(error => { current.close(); throw error })
    }
    pool.users++
    const current = pool
    let released = false
    return { ready: pool.ready, release: () => {
      if (released) return
      released = true
      if (--current.users === 0) current.close()
    } }
  }

  warmQuote(parent: Turn) {
    if (parent.endSeq == null || !parent.sessionId) return () => {}
    const lease = this.acquireQuote(parent)
    void lease.ready.catch(() => {})
    return lease.release
  }

  private rememberQuote(pool) {
    if (!pool?.anchorKey || !pool.input) return
    this.quoteDrafts[pool.anchorKey] = pool.input.draftSnapshot || pool.input.state.getSnapshot().draft
    this.quoteAttachments.set(pool.anchorKey, [...(pool.input.state.getSnapshot().attachmentIds || [])])
    try { localStorage.setItem('dsh-study-tree:quote-drafts', JSON.stringify(this.quoteDrafts)) } catch {}
  }

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
    let mounted = true, stopped = false, saving = false, reference, input, binding, quotePool, quoteLease
    let offEvents = () => {}, offInput = () => {}
    const stop = () => {
      if (stopped) return
      stopped = true
      offEvents(); offInput()
      if (quoteLease) { this.rememberQuote(quotePool); quoteLease.release() }
      else reference?.release()
      this.stops.delete(stop)
    }
    const busy = () => saving || (input && input.state.getSnapshot().phase !== 'plain')
      || binding?.session.getSnapshot().pendingSubmissions.length > 0
    this.stops.add(stop)
    const prepare = kind === 'quote' ? (quoteLease = this.acquireQuote(parent)).ready.then(pool => {
      quotePool = pool
      return pool.reference.sessionId
    }) : this.session(parent, kind, anchor)
    void prepare.then(async sessionId => {
      if (stopped) return
      reference = quotePool?.reference || this.study.ctx.sessions.retain(sessionId, { source: 'studyTree' })
      binding = await reference.ready
      if (stopped) return
      input = this.study.ctx.conversation.input.for(binding.ctx)
      if (quotePool) {
        const anchorKey = JSON.stringify([parent.id, kind, anchor?.start, anchor?.text])
        if (quotePool.anchorKey !== anchorKey) {
          this.rememberQuote(quotePool)
          quotePool.anchorKey = anchorKey
          for (const id of [...(input.state.getSnapshot().attachmentIds || [])]) input.removeAttachment?.(id)
          input.setDraft(this.quoteDrafts[anchorKey] || '')
          const attachments = this.quoteAttachments.get(anchorKey)
          if (attachments?.length) input.addAttachments?.(attachments)
        }
      }
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
          isUserPrompt(event) && event.seq > parent.endSeq,
        )?.event
        if (!message) { if (!mounted && !busy()) stop(); return }
        if (this.study.nodes.some(n => n.sessionId === sessionId && n.requestId === message.data.source.rpcId)) { stop(); return }
        const submission = sessionId + ':' + message.data.source.rpcId
        if (this.accepting.has(submission)) return
        this.accepting.add(submission)
        saving = true
        if (quotePool) quotePool.used = true
        request.sent = true
        this.study.emit()
        const text = message.data.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
        const node: Turn = {
          id: crypto.randomUUID(), treeId: parent.treeId, parentId: parent.id,
          ...nativeQuestion(text, kind === 'card' ? this.cardQuotes[sessionId] || null : anchor), created: Date.now(), sessionId,
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
  dispose() {
    for (const stop of [...this.stops]) stop()
    for (const pool of this.quotePoolRefs) pool.close()
    this.quotePools.clear(); this.seats.clear(); this.listeners.clear()
  }
}
