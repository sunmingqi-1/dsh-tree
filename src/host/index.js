import { z } from 'zod'
import { TreeLog } from '../treeLog.js'

// Native continuation outside the canvas has a canonical session/turn key.
const id = z.union([z.string().uuid(), z.string().regex(/^.+\/\d+$/)])
const anchor = z.object({
  text: z.string().min(1),
  start: z.number().int().nonnegative(),
  prefix: z.string(),
  suffix: z.string(),
})
const node = z.object({
  id,
  treeId: id,
  parentId: id.nullable(),
  question: z.string().min(1),
  logged: z.literal(true).optional(),
  title: z.string().trim().min(1).max(120).optional(),
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
export const inject = ['storageDomain', 'typert', 'sessionPersistence']

export async function apply(ctx) {
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
          result.set(row.id, { ...row, revision: local?.revision ?? 0, title: local?.title })
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
          const saved = { ...durable, title: next.title, revision: next.revision + 1 }
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
  service.typertRemote = { service, serviceKey, namespace: serviceKey }
  ctx.provide(serviceKey, service)
  ctx.typert.register({
    package: 'dsh-study-tree',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: ['list', 'save'].map((method) => ({
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
