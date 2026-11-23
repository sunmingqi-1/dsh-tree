import { z } from 'zod'
import { principalOf, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { TreeLog } from '../treeLog.js'
import { MATERIAL_RECORD } from '../material.js'
import { nodeMarks } from '../nodeMarks.js'
import { prepareTreePrompt } from './routing.js'

// Native continuation outside the canvas has a canonical session/turn key.
const id = z.union([z.string().uuid(), z.string().regex(/^.+\/\d+$/)])
const anchor = z.object({
  text: z.string().min(1),
  start: z.number().int().nonnegative(),
  prefix: z.string(),
  suffix: z.string(),
  revision: z.number().int().positive().optional(),
})
const node = z.object({
  id,
  treeId: id,
  parentId: id.nullable(),
  question: z.string().min(1),
  logged: z.literal(true).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  mark: z.enum(Object.keys(nodeMarks)).nullable().optional(),
  branchKind: z.enum(['card', 'quote']).optional(),
  versionOf: id.optional(),
  anchor: anchor.nullable(),
  created: z.number(),
  sessionId: z.string().nullable(),
  requestId: z.string().nullable(),
  endSeq: z.number().int().nonnegative().nullable(),
  status: z.enum(['preparing', 'sending', 'complete', 'failed', 'stopped']),
  error: z.string().nullable(),
  revision: z.number().int().nonnegative(),
})
const serviceKey = 'studyTree'
const json = { mode: 'src-json' }
const materialRef = z.object({ id, revision: z.number().int().positive() })
const materialRequest = z.object({
  id: z.string().uuid(),
  sessionId: z.string().min(1),
  parentId: id,
  kind: z.enum(['markdown', 'code']),
  question: z.string().trim().min(1).max(120),
  content: z.string().max(64_000),
  language: z.string().max(32).regex(/^[\w+#.\-]*$/).optional(),
  revision: z.number().int().nonnegative(),
  mark: z.enum(Object.keys(nodeMarks)).nullable().optional(),
  anchor: anchor.nullable(),
})
const prompt = z.object({
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  parentSeq: z.number().int().nonnegative().nullable(),
  metadata: z.object({ studyTree: z.object({ id, anchor: anchor.nullable().optional(), versionOf: id.optional(),
    material: materialRef.optional(), branchKind: z.enum(['card', 'quote']).optional() }) }),
})
export const inject = ['storageDomain', 'typert', 'sessionPersistence', 'sessions', 'sessionController', 'remoteAccess']

const liveLogs = new WeakMap()
function liveLog(session) {
  let log = liveLogs.get(session)
  if (!log) liveLogs.set(session, log = new TreeLog(session.id))
  for (const event of session.snapshotEvents(log.nextSeq)) log.append(event)
  return log
}

class StudyTreeRemote extends TypertRemoteService {
  constructor(ctx, rows) {
    super(ctx, serviceKey)
    this.rows = rows
  }

  // rc.5's sessionController registers a gateway resource reader for every
  // namespace, extracting request.sessionId before resolving any Agent. Also
  // require the caller's native prompt permission before declaring a tree.
  checkPromptAccess(request) {
    const principal = principalOf(this.ctx.invocation)
    if (!principal) return
    const action = 'session/prompt'
    const decision = this.ctx.remoteAccess.decide({
      principal, action, resources: [{ kind: 'session', id: request.sessionId }],
      args: { request: { sessionId: request.sessionId, requestId: request.requestId, mode: 'queue' } },
    })
    if (decision.kind !== 'allow') throw new RemoteError('remote-access/denied', '无权在此会话中提问',
      { action, reason: decision.reason })
  }

  async preparePrompt(input) {
    const request = prompt.parse(input)
    this.checkPromptAccess(request)
    const found = await this.ctx.sessionController.resolveAgent(request.sessionId)
    if ('error' in found) throw found.error
    this.ctx.invocation?.signal?.throwIfAborted()
    this.checkPromptAccess(request)
    const reference = request.metadata.studyTree.material
    if (reference) {
      const log = liveLog(found.agent.session)
      const material = log.material(reference)
      const boundary = log.boundaries.get(request.parentSeq)
      if (!material || !boundary || log.nearestTurn(material)?.id !== boundary.id)
        throw new Error('资料版本与提问分支不匹配')
    }
    prepareTreePrompt(this.ctx, found.agent, request)
    await this.ctx.sessions.flush(found.agent.session)
    return { prepared: true }
  }

  async saveMaterial(input) {
    const next = materialRequest.parse(input)
    this.checkPromptAccess(next)
    const session = this.ctx.sessions.get(next.sessionId)
    if (!session?.isTree) throw new Error('学习树会话尚未就绪')
    const log = liveLog(session)
    const parent = log.nodes.get(next.parentId)
    const previous = log.nodes.get(next.id)
    if (!parent || !log.nearestTurn(parent)) throw new Error('资料的父节点不可用')
    if ((previous?.revision ?? 0) !== next.revision) throw new Error('资料已在其他窗口更新，请重新打开编辑')
    if (previous && (previous.kind !== next.kind || previous.parentId !== next.parentId))
      throw new Error('资料卡片的类型或来源发生变化')
    const saved = {
      ...next,
      treeId: log.rootId,
      created: previous?.created ?? Date.now(),
      anchor: previous ? previous.anchor : next.anchor,
      branchKind: 'card',
      revision: next.revision + 1,
    }
    this.ctx.sessions.recordStudyTree(session, MATERIAL_RECORD, saved)
    await this.ctx.sessions.flush(session)
    return saved
  }

  readMaterial(input) {
    const { sessionId, ...ref } = materialRef.extend({ sessionId: z.string().min(1) }).parse(input)
    if (principalOf(this.ctx.invocation) && !this.ctx.remoteAccess.allows({ kind: 'session', id: sessionId }))
      throw new RemoteError('remote-access/denied', '无权读取此会话')
    const session = this.ctx.sessions.get(sessionId)
    const material = session?.isTree && liveLog(session).material(ref)
    if (!material) throw new Error('提问时的资料版本不可用')
    return material
  }

  async list() {
    const rows = await this.rows.list()
    if (!principalOf(this.ctx.invocation)) return rows
    return rows.filter(row => row.sessionId && this.ctx.remoteAccess.allows({ kind: 'session', id: row.sessionId }))
  }

  save(input) { return this.rows.save(input) }
}

export async function apply(ctx) {
  ctx.inject?.(['sessionLogDeepSeek'], scoped => {
    scoped.sessionLogDeepSeek.registerExclusion(({ sessionId }) => ctx.sessions.get(sessionId)?.isTree === true)
  })
  const domain = await ctx.storageDomain.open({
    name: 'study_tree',
    version: 1,
    tables: { nodes: { valueSchema: node } },
  })
  ctx.effect(() => () => domain.close())
  const table = domain.table('nodes')
  let tail = Promise.resolve()
  const logs = new Map()
  async function updateLogs() {
    const sessions = await ctx.sessionPersistence.list()
    const visible = new Set()
    for (const { header, revision, formatStatus } of sessions) {
      const id = header.id
      if (header.isSeeded || formatStatus === 'migration-required') continue
      visible.add(id)
      const cached = logs.get(id) || { log: new TreeLog(id) }
      if (cached.ordinary || cached.revision === revision) continue
      const handle = await ctx.sessionPersistence.open(id, 'read')
      try {
        for (;;) {
          const { events } = await handle.read(cached.log.nextSeq, 256)
          for (const event of events) {
            cached.log.append(event)
            if (!cached.log.marked && event.type === 'turn/start') {
              cached.ordinary = true
              break
            }
          }
          if (cached.ordinary || events.length < 256) break
        }
        cached.revision = revision
        logs.set(id, cached)
      } finally { await handle.close() }
    }
    for (const id of logs.keys()) if (!visible.has(id)) logs.delete(id)
  }
  let updating
  const service = {
    async list() {
      updating ??= updateLogs().finally(() => { updating = undefined })
      await updating
      const result = new Map([...table.entries()].filter(([, row]) => !row.logged))
      for (const { log } of logs.values()) {
        for (const row of log.nodes.values()) {
          const local = table.get(row.id)
          result.set(row.id, row.kind ? row : { ...row, revision: local?.revision ?? 0, title: local?.title, mark: local?.mark })
        }
      }
      return [...result.values()]
    },
    save(request) {
      const work = tail.then(async () => {
        const next = node.parse(request)
        const old = table.get(next.id)
        if (next.logged) {
          const rows = await service.list()
          const durable = rows.find(item => item.logged && item.id === next.id && item.sessionId === next.sessionId)
          if (!durable) throw new Error('未能读取节点的会话日志，请刷新后重试')
          if (durable.revision !== next.revision) throw new Error('节点已更新，请刷新学习树')
          const saved = { ...durable, title: next.title, mark: next.mark === undefined ? durable.mark : next.mark, revision: next.revision + 1 }
          await table.put(saved.id, node.parse(saved))
          return saved
        }
        if (old) {
          if (old.revision !== next.revision) throw new Error('节点已更新，请刷新学习树')
          for (const key of ['treeId', 'parentId', 'question', 'created']) {
            if (next[key] !== old[key]) throw new Error('节点来源发生变化')
          }
          if (JSON.stringify(next.anchor) !== JSON.stringify(old.anchor))
            throw new Error('引用来源发生变化')
          if (old.sessionId && old.sessionId !== next.sessionId) throw new Error('会话已绑定')
        } else {
          if (next.revision !== 0) throw new Error('节点版本无效')
          if (next.parentId) {
            if (table.get(next.parentId)?.treeId !== next.treeId) throw new Error('来源节点不可用')
          } else if (next.id !== next.treeId) throw new Error('根节点无效')
        }
        const saved = { ...next, revision: next.revision + 1 }
        await table.put(saved.id, saved)
        return saved
      })
      tail = work.catch(() => {})
      return work
    },
  }
  new StudyTreeRemote(ctx, service)
  ctx.typert.register({
    package: 'dsh-study-tree',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: ['list', 'save', 'preparePrompt', 'saveMaterial', 'readMaterial'].map((method) => ({
      id: 'dsh-study-tree#studyTree/' + method,
      service: serviceKey,
      namespace: serviceKey,
      method,
      invocation: { kind: 'direct' },
      result: json,
      parameters:
        method === 'list'
          ? []
          : [{ name: 'request', wire: 'request', source: 'json', codec: json }],
    })),
  })
}
