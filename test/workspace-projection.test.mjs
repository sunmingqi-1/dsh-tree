import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const output = await build({ entryPoints: [fileURLToPath(new URL('../src/client/workspaceProjection.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false })
const { workspaceProjection } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'))
const root = { id: 'root', treeId: 'root', parentId: null, sessionId: 'root-session' }
const child = { id: 'child', treeId: 'root', parentId: 'root', sessionId: 'child-session' }
const summary = (id, mainView = 0) => ({ id, blank: false, retainedBy: { mainView, studyTree: 1 } })
const list = ids => ({ ids, byId: Object.fromEntries(ids.map(id => [id, summary(id)])), phase: 'ready' })

test('分页之前剔除草稿和树的子会话，每个主题只占一条原生记录', () => {
  const source = list(['draft-a', 'draft-b', 'child-session', 'root-session', ...Array.from({ length: 8 }, (_, i) => 'normal-' + i)])
  const project = workspaceProjection([root, child], ['draft-a', 'draft-b'])
  const result = project(source)
  assert.deepEqual(result.ids.slice(0, 6), ['root-session', 'normal-0', 'normal-1', 'normal-2', 'normal-3', 'normal-4'])
  assert.equal(Object.keys(result.byId).length, 9)
  assert.equal(source.ids.length, 12)
  assert.ok(source.byId['child-session'])
  assert.strictEqual(project(source), result)
  assert.strictEqual(result.byId['normal-0'], source.byId['normal-0'])
})

test('选中子节点时侧栏保留根主题的选中状态，不修改真实 Session 引用', () => {
  const source = list(['root-session', 'child-session'])
  source.byId['child-session'] = summary('child-session', 1)
  const result = workspaceProjection([root, child], [])(source)
  assert.equal(result.byId['root-session'].retainedBy.mainView, 1)
  assert.equal(source.byId['root-session'].retainedBy.mainView, 0)
  assert.equal(source.byId['child-session'].retainedBy.mainView, 1)
})

test('已成为节点的 Session 不因仍留在草稿索引中而隐藏，多个根分别保留', () => {
  const other = { ...root, id: 'other', treeId: 'other', sessionId: 'other-session' }
  const source = list(['root-session', 'other-session', 'child-session'])
  const result = workspaceProjection([root, child, other], ['root-session', 'other-session', 'child-session'])(source)
  assert.deepEqual(result.ids, ['root-session', 'other-session'])
})

test('根会话暂未加载时不把子会话错误提升到另一个工作区', () => {
  const source = list(['child-session', 'ordinary'])
  const result = workspaceProjection([root, child], [])(source)
  assert.deepEqual(result.ids, ['ordinary'])
})

test('阅读区使用临时会话时，把侧栏选中状态映射到其所属根主题', () => {
  const source = list(['root-session', 'reader-draft'])
  source.byId['reader-draft'] = summary('reader-draft', 1)
  const result = workspaceProjection([root], ['reader-draft'], { 'reader-draft': 'root-session' })(source)
  assert.deepEqual(result.ids, ['root-session'])
  assert.equal(result.byId['root-session'].retainedBy.mainView, 1)
})
