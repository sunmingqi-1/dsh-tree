import { z } from 'zod'

const id = z.string().uuid()
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
export const inject = ['storageDomain', 'typert']

export async function apply(ctx) {
  const domain = await ctx.storageDomain.open({
    name: 'study_tree',
    version: 1,
    tables: { nodes: { valueSchema: node } },
  })
  ctx.effect(() => () => domain.close())
  const table = domain.table('nodes')
  let tail = Promise.resolve()
  const service = {
    list() {
      return Array.from(table.entries(), ([, item]) => item)
    },
    save(request) {
      const work = tail.then(async () => {
        const next = node.parse(request)
        const old = table.get(next.id)
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
