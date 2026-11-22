const presetPackage = '@deepseek-ai/dsh-agent-preset'
const jobsPackage = '@deepseek-ai/dsh-tool-jobs'
const subagentPackage = '@deepseek-ai/dsh-subagent'
// Official entry IDs identify the final profile configuration, including local
// overrides. The package guard avoids adopting an unrelated row with that ID.
const sources = new Map([
  ['session-store', ['session', 'session']],
  ['persistence-jsonl', ['session-persistence-jsonl', 'session-persistence-jsonl']],
  ['session-projection', ['session-projection', 'session-projection']],
  ['session-query', ['session-query-sqlite', 'session-query-sqlite']],
  ['token-meter', ['token-meter', 'token-meter']],
  ['goal-round-driver', ['goal-round-driver', 'goal-round-driver']],
  ['jobs-local', ['jobs', 'jobs-local']],
  ['subagent', ['subagent', 'subagent']],
  ['subagent-fork-in-process', ['subagent-fork-in-process', 'subagent-fork-in-process']],
  ['agent-loop', ['agent-loop', 'agent-loop']],
].map(([replacement, source]) => ['dsh-study-tree/' + replacement, source]))

function routeRows(rows) {
  if (!Array.isArray(rows)) return rows
  let routed = rows
  for (const [index, row] of rows.entries()) {
    let next = row
    if (row?.name === jobsPackage) next = { ...row, name: 'dsh-study-tree/tool-jobs' }
    else if (row?.group === true || row?.name === 'cordis:group' || row?.name === '@deepseek-ai/cordis-plugin-group') {
      const config = routeRows(row.config)
      if (config !== row.config) next = { ...row, config }
    }
    if (next === row) continue
    if (routed === rows) routed = rows.slice()
    routed[index] = next
  }
  return routed
}

// rc.5 resolves the declaring preset's configuration before register() eagerly
// mounts its own Loader tree. Only transform that activation's plugin rows.
// The ordinary registry, profile source and platform expressions stay intact.
export function apply(ctx) {
  ctx.on('internal/config', (fiber, next) => {
    const config = next()
    const entry = fiber.entry
    if (!entry || fiber.parent.fiber.entry === entry) return config
    const source = sources.get(entry.options.name)
    if (source) {
      const [id, packageSuffix] = source
      const official = entry.parent.tree.resolve(id).options
      if (official.name !== '@deepseek-ai/dsh-' + packageSuffix)
        throw new Error('学习树无法继承配置：' + id + ' 的宿主包名不匹配')
      // Returning the raw profile row lets the native Loader evaluate !!js
      // exactly when the replacement's own dependencies and schema are ready.
      if (config == null) return official.config
      if (official.config == null) return config
      const object = value => typeof value?.__jsExpr === 'string' ? entry.evaluate(value.__jsExpr) : value
      return { ...object(official.config), ...object(config) }
    }
    if (entry.options.name !== presetPackage) return config
    const plugins = routeRows(config?.plugins)
    return plugins === config?.plugins ? config : { ...config, plugins }
  })
  // A subpath is not a Typert discovery root. Append the official descriptors
  // after the user's packages and expressions have passed the native schema.
  ctx.on('internal/config', (fiber, next) => {
    const config = next()
    if (fiber.entry?.options.name !== '@deepseek-ai/dsh-typert-loader'
      || fiber.parent.fiber.entry === fiber.entry || config.packages.includes(subagentPackage)) return config
    return { ...config, packages: [...config.packages, subagentPackage] }
  }, { prepend: true })
  ctx.provide('studyTreePresetRouting', true)
}
