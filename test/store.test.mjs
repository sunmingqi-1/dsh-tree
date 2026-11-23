import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/host/index.js'

test('并发旧版本写入被拒绝，兄弟节点可以独立保存', async () => {
  const rows = new Map(),
    services = new Map()
  await apply({
    sessionPersistence: { list: async () => [] },
    storageDomain: {
      open: async () => ({
        table: () => ({
          get: (id) => rows.get(id),
          put: async (id, n) => rows.set(id, n),
          entries: () => rows.entries(),
        }),
      }),
    },
    effect() {},
    reflect: { provide: (key, s) => services.set(key, s) },
    typert: { register() {} },
  })
  const store = services.get('studyTree'),
    id = crypto.randomUUID()
  const root = await store.save({
    id,
    treeId: id,
    parentId: null,
    question: 'DSH',
    created: 1,
    anchor: null,
    sessionId: null,
    requestId: null,
    endSeq: null,
    status: 'preparing',
    error: null,
    revision: 0,
  })
  const [a, b] = await Promise.allSettled([
    store.save({ ...root, title: '主题' }),
    store.save({ ...root, title: '旧标题' }),
  ])
  assert.equal(a.status, 'fulfilled')
  assert.equal(b.status, 'rejected')
  const child = () => ({ ...root, id: crypto.randomUUID(), parentId: root.id, revision: 0 })
  await Promise.all([store.save(child()), store.save(child())])
  assert.equal((await store.list()).length, 3)
  await assert.rejects(store.save({ ...child(), treeId: crypto.randomUUID() }))
})
