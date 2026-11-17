import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const output = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/nativeControls.tsx', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', write: false,
})
const { controlSeat, mirrorNativeControl } = await import(
  'data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64')
)

// Model only the registry contracts used by the adapter: inject effects follow
// declaration lifetimes synchronously, each child has one declaring owner, and
// a subscription callback already captured for dispatch can arrive after off().
function slotRegistry(initial) {
  const records = new Map(), declarations = new Map(), injections = new Map()
  const pending = [], attempts = []
  const record = name => {
    if (!records.has(name)) records.set(name, { source: initial[name] || [], entries: initial[name] || [],
      registrations: [], listeners: new Set() })
    return records.get(name)
  }
  const publish = name => {
    const state = record(name)
    state.entries = [...state.source, ...state.registrations]
    for (const listener of [...state.listeners]) pending.push(listener)
  }
  const declare = (name, spec) => {
    if (declarations.has(name)) throw Error(`slot "${name}" is already declared`)
    const token = { spec }
    declarations.set(name, token)
    for (const effect of [...(injections.get(name) || [])]) effect.stop = effect.setup()
    let active = true
    return () => {
      if (!active) return
      active = false
      assert.strictEqual(declarations.get(name), token)
      declarations.delete(name)
      for (const effect of [...(injections.get(name) || [])]) {
        const stop = effect.stop
        effect.stop = undefined
        stop?.()
      }
    }
  }
  const slots = {
    entries: name => record(name).entries,
    subscribe(name, listener) {
      const listeners = record(name).listeners
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    inject(name, setup) {
      if (!injections.has(name)) injections.set(name, new Set())
      const effects = injections.get(name), effect = { setup, stop: undefined }
      effects.add(effect)
      if (declarations.has(name)) effect.stop = setup()
      return () => {
        if (!effects.delete(effect)) return
        const stop = effect.stop
        effect.stop = undefined
        stop?.()
      }
    },
    register(options, component) {
      attempts.push(options)
      if (!declarations.has(options.name)) throw Error(`slot "${options.name}" is not declared`)
      for (const child of Object.keys(options.children || {})) {
        if (declarations.has(child)) throw Error(`slot "${child}" is already declared`)
      }
      const entry = { options, component, select: options.select, children: options.children,
        inject: options.inject, store: options.store, locale: options.locale }
      const state = record(options.name)
      state.registrations.push(entry)
      const childStops = Object.entries(options.children || {}).map(([name, spec]) => declare(name, spec))
      publish(options.name)
      let active = true
      return () => {
        if (!active) return
        active = false
        for (const stop of childStops.reverse()) stop()
        state.registrations.splice(state.registrations.indexOf(entry), 1)
        publish(options.name)
      }
    },
  }
  return {
    ctx: { slots }, slots, attempts, declare,
    update(name, entries) { record(name).source = entries; publish(name) },
    flush() {
      let count = 0
      while (pending.length) {
        if (++count > 100) throw Error('slot callbacks did not settle')
        pending.shift()()
      }
    },
  }
}

function nativeEntry(id, overrides = {}) {
  return {
    options: { id }, component: function NativeForm() { return null },
    children: {}, inject: () => ({}), store: { id }, locale: 'test-native',
    ...overrides,
  }
}

test('父 slot 撤销并重建后，旧排队回调不能重新声明 plan-review.actions', () => {
  const source = 'conversation.input.plan'
  const alias = controlSeat(source), actionsAlias = controlSeat('plan-review.actions')
  const entry = nativeEntry('plan-review', {
    children: { 'plan-review.actions': { kind: 'single', scope: 'session' } },
  })
  const registry = slotRegistry({ [source]: [entry] })
  const stopMirror = mirrorNativeControl(registry.ctx, source)
  assert.deepEqual(registry.slots.entries(alias), [])
  const stopFirstDeclaration = registry.declare(alias, { kind: 'single', scope: 'session' })
  const first = registry.slots.entries(alias)[0]
  assert.ok(first)
  assert.ok(first.children[actionsAlias])

  // Capture the first lifetime's sync callback, then dispose its injection
  // before the dispatch is allowed to run. A new array represents a registry
  // mutation even when the source's surviving entry has the same identity.
  registry.update(source, [entry])
  stopFirstDeclaration()
  assert.deepEqual(registry.slots.entries(alias), [])
  const stopSecondDeclaration = registry.declare(alias, { kind: 'single', scope: 'session' })
  const second = registry.slots.entries(alias)[0]
  assert.notStrictEqual(second.component, first.component)
  assert.doesNotThrow(() => registry.flush())
  assert.strictEqual(registry.slots.entries(alias)[0], second)
  assert.equal(registry.slots.entries(alias).length, 1)
  assert.equal(registry.attempts.filter(options => options.name === alias).length, 2)

  stopSecondDeclaration()
  stopMirror()
  assert.deepEqual(registry.slots.entries(alias), [])
  // The final teardown also released the declaration's child ownership.
  registry.declare(actionsAlias, { kind: 'single', scope: 'session' })()
})

test('增量添加 source entry 不替换既存表单 adapter，删除新增项也保留原实例身份', () => {
  const source = 'conversation.composer', alias = controlSeat(source)
  const first = nativeEntry('question'), second = nativeEntry('approval')
  const registry = slotRegistry({ [source]: [first] })
  const stopDeclaration = registry.declare(alias, { kind: 'chain', scope: 'session' })
  const stopMirror = mirrorNativeControl(registry.ctx, source)
  const mounted = registry.slots.entries(alias)[0]
  registry.update(source, [first, second])
  registry.flush()
  assert.equal(registry.slots.entries(alias).length, 2)
  assert.strictEqual(registry.slots.entries(alias)[0], mounted)
  assert.strictEqual(registry.slots.entries(alias)[0].component, mounted.component)
  assert.equal(registry.attempts.filter(options => options.id === 'question').length, 1)
  registry.update(source, [first])
  registry.flush()
  assert.deepEqual(registry.slots.entries(alias), [mounted])
  assert.equal(registry.attempts.filter(options => options.id === 'question').length, 1)
  stopMirror(); stopDeclaration()
  assert.deepEqual(registry.slots.entries(alias), [])
})

test('仅变换被适配的原生入口，子 slot 保持原组件和依赖', () => {
  const source = 'sidebar.workspaces', child = 'sidebar.session.row.trailing'
  const entry = nativeEntry('browser', { children: { [child]: { kind: 'list', scope: 'root' } } })
  const trailing = nativeEntry('directory')
  const registry = slotRegistry({ [source]: [entry], [child]: [trailing] })
  const stopDeclaration = registry.declare(controlSeat(source), { kind: 'single', scope: 'root' })
  const calls = []
  const stop = mirrorNativeControl(registry.ctx, source, undefined, component => { calls.push(component); return component })
  assert.deepEqual(calls, [entry.component])
  assert.ok(registry.slots.entries(controlSeat(child))[0])
  registry.update(source, [entry]); registry.flush()
  assert.deepEqual(calls, [entry.component])
  stop(); stopDeclaration()
})

test('chain 镜像显式保留注册选项之外的原生 select 和依赖上下文', () => {
  const source = 'conversation.composer', alias = controlSeat(source)
  const select = owner => owner.pendingInteraction?.kind === 'question' ? owner.pendingInteraction : null
  const entry = nativeEntry('question', { select })
  assert.equal(entry.options.select, undefined)
  const registry = slotRegistry({ [source]: [entry] })
  const stopDeclaration = registry.declare(alias, { kind: 'chain', scope: 'session' })
  const stopMirror = mirrorNativeControl(registry.ctx, source)
  const mirrored = registry.slots.entries(alias)[0]
  assert.strictEqual(mirrored.select, select)
  const pending = { key: 'question', kind: 'question', sessionId: 'session' }
  assert.strictEqual(mirrored.select({ pendingInteraction: pending }), pending)
  assert.equal(mirrored.select({ pendingInteraction: { kind: 'approval' } }), null)
  assert.equal(mirrored.select({}), null)
  assert.strictEqual(mirrored.inject, entry.inject)
  assert.strictEqual(mirrored.store, entry.store)
  assert.equal(mirrored.locale, 'test-native')
  stopMirror(); stopDeclaration()
})
