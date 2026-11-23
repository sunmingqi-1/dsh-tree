import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../src/host/presetRegistry.js'

const stockJobs = '@deepseek-ai/dsh-tool-jobs'
const preset = '@deepseek-ai/dsh-agent-preset'
const treeJobs = 'dsh-study-tree/tool-jobs'
function setup(original = {}) {
  const hooks = []
  hooks.push((fiber, next) => {
    const config = next()
    if (fiber.entry.options.name !== '@deepseek-ai/dsh-typert-loader') return config
    const raw = config?.packages
    const packages = raw?.__jsExpr ? JSON.parse(raw.__jsExpr) : raw ?? []
    return { packages }
  })
  apply({
    on(name, callback, options) { assert.equal(name, 'internal/config'); hooks[options?.prepend ? 'unshift' : 'push'](callback) },
    provide(name, ready) { assert.equal(hooks.length, 3); assert.equal(name, 'studyTreePresetRouting'); assert.equal(ready, true) },
  })
  return (config, name = preset, child = false) => {
    const tree = { resolve(id) { assert.ok(id in original, 'missing source ' + id); return { options: original[id] } } }
    const entry = { options: { name }, parent: { tree } }
    const fiber = { entry, parent: { fiber: { entry: child ? entry : undefined } } }
    return hooks.reduceRight((next, callback) => () => callback(fiber, next), () => config)()
  }
}

test('默认、PTC、Cordis 和自定义预设继承原配置，依声明顺序装载学习树后台工具', () => {
  const resolve = setup()
  for (const id of ['standard', 'ptc', 'cordis', 'custom']) {
    const options = { waitTimeoutMs: 50, completionDelivery: 'quiet' }
    const disabled = { __jsExpr: "process.platform === 'win32'" }
    const job = Object.freeze({ name: stockJobs, config: options, disabled, inject: ['jobs'], id: 'my-jobs' })
    const ordinary = { name: 'my-plugin', config: [{ name: stockJobs }] }
    const nested = { name: 'cordis:group', group: true, isolate: { tools: true }, config: [job, ordinary] }
    const config = Object.freeze({ id, name: '自定义名称', order: 7, plugins: Object.freeze([ordinary, job, nested]) })
    const routed = resolve(config)
    assert.deepEqual(routed, { ...config, plugins: [ordinary, { ...job, name: treeJobs }, {
      ...nested, config: [{ ...job, name: treeJobs }, ordinary],
    }] })
    assert.equal(routed.plugins[1].config, options)
    assert.equal(routed.plugins[2].config[0].disabled, disabled)
    assert.equal(routed.plugins[0], ordinary)
    assert.equal(config.plugins[1].name, stockJobs)
    assert.equal(resolve(routed), routed)
  }
})

test('minimal 未声明后台工具，其他插件的配置、相似包名和预设内普通数据均按原样读取', () => {
  const resolve = setup()
  const minimal = { id: 'minimal', plugins: [{ name: 'helper', config: [{ name: stockJobs }] }, { name: stockJobs + '/other' }] }
  assert.equal(resolve(minimal), minimal)
  const unrelated = { plugins: [{ name: stockJobs }] }
  assert.equal(resolve(unrelated, 'another-plugin'), unrelated)
  assert.equal(resolve(unrelated, preset, true), unrelated)
})

test('替换存储、查询、Agent 和 fork 服务时沿用有效 profile 配置及宿主默认值', () => {
  const root = { __jsExpr: "dshHomePath('custom')" }
  const sources = {
    'session-persistence-jsonl': { name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root, compression: 'none' } },
    'session-query-sqlite': { name: '@deepseek-ai/dsh-session-query-sqlite', config: { path: 'custom.sqlite', openAt: 'startup' } },
    'agent-loop': { name: '@deepseek-ai/dsh-agent-loop', config: { agents: ['existing-agent'] } },
    'subagent-fork-in-process': { name: '@deepseek-ai/dsh-subagent-fork-in-process', config: { providerName: 'fork' } },
    'jobs': { name: '@deepseek-ai/dsh-jobs-local' },
  }
  const resolve = setup(sources)
  for (const [name, id] of [['session-query', 'session-query-sqlite'], ['agent-loop', 'agent-loop'],
    ['subagent-fork-in-process', 'subagent-fork-in-process'], ['jobs-local', 'jobs']]) {
    assert.equal(resolve(undefined, 'dsh-study-tree/' + name), sources[id].config)
  }
  assert.equal(resolve(undefined, 'dsh-study-tree/persistence-jsonl').root, root)
  assert.deepEqual(resolve({ compression: 'zstd' }, 'dsh-study-tree/persistence-jsonl'), { root, compression: 'zstd' })
  assert.equal(sources['session-persistence-jsonl'].config.compression, 'none')
  assert.throws(() => setup({ jobs: { name: 'unrelated' } })(undefined, 'dsh-study-tree/jobs-local'), /包名不匹配/)
})

test('Typert 补齐 subagent 远程描述，保留表达式配置的包和顺序，显式声明时不重复', () => {
  const resolve = setup(), loader = '@deepseek-ai/dsh-typert-loader', pkg = '@deepseek-ai/dsh-subagent'
  assert.deepEqual(resolve(undefined, loader), { packages: [pkg] })
  assert.deepEqual(resolve({ packages: { __jsExpr: '["my-api","second-api"]' } }, loader), { packages: ['my-api', 'second-api', pkg] })
  assert.deepEqual(resolve({ packages: ['my-api', pkg] }, loader), { packages: ['my-api', pkg] })
})
