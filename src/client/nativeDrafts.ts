import { isUserPrompt, type Anchor, type Turn } from './tree'

export const quoteText = (text: string) => text.replace(/\r\n?/g, '\n').split('\n').map(line => '> ' + line).join('\n')
export function nativeQuestion(text: string, anchor: Anchor | null) {
  const quote = anchor && quoteText(anchor.text)
  const linked = quote && text.includes(quote) ? anchor : null
  const question = (linked ? text.replace(quote, '') : text).trim()
  return { question: question || (linked ? '解释这段内容' : '阅读附件'), anchor: linked }
}

export class NativeDrafts {
  seats = new Map<HTMLElement, { key: string; parent: Turn; kind: 'card' | 'quote'; anchor: Anchor | null; shared?: boolean; sent?: boolean; pending?: boolean }>()
  private listeners = new Set<() => void>()
  private version = 0
  readerVisible = true
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  getSnapshot = () => this.version
  emit() { this.version++; for (const listener of this.listeners) listener() }
  private quotePools = new Map<string, any>()
  private quotePoolRefs = new Set<any>()
  private idleQuote: { parentId: string; pool: any } | null = null
  private quoteAttachments = new Map<string, readonly string[]>()
  private quoteDrafts: Record<string, any> = (() => {
    try { return JSON.parse(localStorage.getItem('dsh-study-tree:quote-drafts') || '{}') } catch { return {} }
  })()
  sessions: Record<string, string> = (() => {
    try { return JSON.parse(localStorage.getItem('dsh-study-tree:composer-drafts') || '{}') } catch { return {} }
  })()
  private pending = new Map<string, Promise<string>>()
  private deferredQuotes = new Map<string, Anchor>()
  private cardEditors = new Map<string, { input: any; sessionId: string }>()
  private cardQuotes: Record<string, Anchor> = (() => {
    try { return JSON.parse(localStorage.getItem('dsh-study-tree:card-quotes') || '{}') } catch { return {} }
  })()
  async addToCard(parent: Turn, anchor: Anchor) {
    const editor = this.cardEditors.get(parent.id)
    if (editor) this.insertCardQuote(editor, anchor)
    else {
      this.deferredQuotes.set(parent.id, anchor)
      this.emit()
    }
  }
  pendingQuote(id: string) { return this.deferredQuotes.get(id) }
  private insertCardQuote({ input, sessionId }, anchor: Anchor) {
    if (input.state.getSnapshot().phase !== 'plain') throw new Error('请等待当前提问发送完成后再添加引用')
    if (input.insertQuote(anchor.text) === false) throw new Error('引用未能加入输入框，请重试')
    this.cardQuotes[sessionId] = anchor
    this.persistCardQuotes()
  }
  private persistCardQuotes() {
    try { localStorage.setItem('dsh-study-tree:card-quotes', JSON.stringify(this.cardQuotes)) } catch {}
  }
  private stops = new Set<() => void>()
  private accepting = new Set<string>()
  private migrated = (() => {
    try { return new Set<string>(JSON.parse(localStorage.getItem('dsh-study-tree:native-draft-migration') || '[]')) } catch { return new Set<string>() }
  })()
  private migratedForkDrafts = (() => {
    try { return new Set<string>(JSON.parse(localStorage.getItem('dsh-study-tree:fork-draft-migration') || '[]')) } catch { return new Set<string>() }
  })()
  private submissions: Record<string, Turn> = (() => {
    try { return JSON.parse(localStorage.getItem('dsh-study-tree:native-submissions') || '{}') } catch { return {} }
  })()
  constructor(readonly study: any) {}

  private acquireQuote(parent: Turn) {
    if (this.idleQuote) {
      const idle = this.idleQuote
      this.idleQuote = null
      if (idle.parentId !== parent.id) idle.pool.close()
    }
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
      if (--current.users !== 0) return
      if (current.closed || current.used || !current.input || this.quotePools.get(parent.id) !== current) {
        current.close()
        return
      }
      this.idleQuote?.pool.close()
      this.idleQuote = { parentId: parent.id, pool: current }
    } }
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

  private hasLaterTurn(parent: Turn, binding) {
    return binding.eventSource.getSnapshot().entries.some(({ event }) =>
      event.seq > parent.endSeq && (isUserPrompt(event) || event.type === 'turn/start'),
    ) || this.study.nodes.some(node => node.sessionId === parent.sessionId && node.id !== parent.id
      && (node.endSeq === null ? node.status === 'sending' : node.endSeq > parent.endSeq))
  }

  private session(parent: Turn, kind: string, anchor: Anchor | null) {
    const key = JSON.stringify([parent.id, kind, anchor?.start, anchor?.text])
    if (this.pending.has(key)) return this.pending.get(key)!
    const task = (async () => {
      const sessions = this.study.ctx.sessions
      let id = this.sessions[key] || (kind === 'card' ? this.study.readerDrafts?.[parent.id] : undefined)
      if (sessions.list.getSnapshot().byId[id]) {
        const used = await sessions.using(id, { source: 'studyTree' }, async ref => {
          const binding = await ref.ready
          await binding.session.loadThrough(parent.endSeq)
          return binding.eventSource.getSnapshot().entries.some(({ event }) =>
            event.seq > parent.endSeq && (isUserPrompt(event) || event.type === 'turn/start'),
          ) || binding.session.getSnapshot().pendingSubmissions.length > 0
        })
        if (!used) return id
      }
      id = await sessions.fork({ sessionId: parent.sessionId, atSeq: parent.endSeq })
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
    let offEvents = () => {}, offInput = () => {}, offSession = () => {}, editor
    const stop = () => {
      if (stopped) return
      stopped = true
      offEvents(); offInput(); offSession()
      if (editor && this.cardEditors.get(parent.id) === editor) this.cardEditors.delete(parent.id)
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
    }) : kind === 'card' ? Promise.resolve(parent.sessionId) : this.session(parent, 'card', null)
    void prepare.then(async sessionId => {
      if (stopped) return
      reference = quotePool?.reference || this.study.ctx.sessions.retain(sessionId, { source: 'studyTree' })
      binding = await reference.ready
      if (stopped) return
      if (kind === 'card') {
        await binding.session.loadThrough(parent.endSeq)
        if (stopped) return
        if (this.hasLaterTurn(parent, binding)) { ready(null); stop(); return }
      }
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
      if (kind !== 'quote' && !this.migrated.has(parent.id)) {
        try {
          const legacy = JSON.parse(localStorage.getItem('dsh-study-tree:view:v1') || '{}').drafts?.[parent.id]
          if (legacy && !input.state.getSnapshot().draft.trim()) input.setDraft(legacy)
          this.migrated.add(parent.id)
          localStorage.setItem('dsh-study-tree:native-draft-migration', JSON.stringify([...this.migrated]))
        } catch {}
      }
      if (kind === 'card' && !this.migratedForkDrafts.has(parent.id) && !input.state.getSnapshot().draft.trim()) {
        await this.restoreForkDraft(parent, input)
        if (stopped) return
        if (this.hasLaterTurn(parent, binding)) { ready(null); stop(); return }
      }
      if (anchor && !input.state.getSnapshot().draft.trim()) input.insertQuote(anchor.text)
      if (kind !== 'quote') {
        editor = { input, sessionId }
        const pendingQuote = this.deferredQuotes.get(parent.id)
        if (pendingQuote) {
          this.insertCardQuote(editor, pendingQuote)
          this.deferredQuotes.delete(parent.id)
        }
        this.cardEditors.set(parent.id, editor)
      }
      const collectSubmitted = () => {
        const pending = binding.session.getSnapshot().pendingSubmissions.length > 0
        if (pending === !!request.pending) return
        request.pending = pending
        this.emit()
      }
      const read = () => {
        if (stopped || saving) return
        collectSubmitted()
        const message = binding.eventSource.getSnapshot().entries.find(({ event }) =>
          isUserPrompt(event) && event.seq > parent.endSeq,
        )?.event
        if (!message) {
          if (kind === 'card' && this.hasLaterTurn(parent, binding) && !busy()) {
            if (mounted) ready(null)
            stop()
          } else if (!mounted && !busy()) stop()
          return
        }
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
          ...nativeQuestion(text, kind !== 'quote' ? this.cardQuotes[sessionId] || null : anchor), created: Date.now(), sessionId,
          requestId: message.data.source.rpcId, endSeq: null, status: 'sending', error: null, revision: 0,
        }
        if (kind !== 'quote') {
          delete this.cardQuotes[sessionId]
          this.persistCardQuotes()
        }
        this.submissions[node.id] = node
        this.persistSubmissions()
        void this.record(node).then(node => {
          if (mounted) this.study.open(node.id)
        }).catch(() => { this.study.error = '问答已发送，节点暂未保存。请刷新后重试。'; this.study.emit() }).finally(() => { this.accepting.delete(submission); stop() })
      }
      offEvents = binding.eventSource.subscribe(read)
      offSession = binding.session.subscribe?.(collectSubmitted) || offSession
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
  private async restoreForkDraft(parent: Turn, input) {
    const sessions = this.study.ctx.sessions
    const legacyIds = [this.sessions[JSON.stringify([parent.id, 'card', null, null])], this.study.readerDrafts?.[parent.id]]
    for (const id of legacyIds) {
      if (!id || id === parent.sessionId || !sessions.list.getSnapshot().byId[id]) continue
      const legacy = await sessions.using(id, { source: 'studyTree' }, async ref => {
        const binding = await ref.ready
        return this.study.ctx.conversation.input.for(binding.ctx).draftSnapshot
      }).catch(() => null)
      if (!legacy?.text?.trim()) continue
      if (!input.state.getSnapshot().draft.trim()) {
        input.setDraft(legacy)
        if (this.cardQuotes[id]) {
          this.cardQuotes[parent.sessionId] = this.cardQuotes[id]
          this.persistCardQuotes()
        }
        this.migratedForkDrafts.add(parent.id)
        try { localStorage.setItem('dsh-study-tree:fork-draft-migration', JSON.stringify([...this.migratedForkDrafts])) } catch {}
      }
      return
    }
  }
  dispose() {
    for (const stop of [...this.stops]) stop()
    for (const pool of this.quotePoolRefs) pool.close()
    this.idleQuote = null
    this.quotePools.clear(); this.seats.clear(); this.listeners.clear()
  }
}
