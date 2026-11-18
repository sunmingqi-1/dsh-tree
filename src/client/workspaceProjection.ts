// Only the native sidebar sees this projection. Real Session data, workspace
// membership, retention and conversation bindings remain authoritative elsewhere.
export function workspaceProjection(nodes, drafts: readonly string[], draftOwners: Record<string, string> = {}) {
  const owner = new Map<string, string>()
  const roots = new Map(nodes.filter(n => !n.parentId).map(n => [n.id, n.sessionId]))
  for (const node of nodes) owner.set(node.sessionId, roots.get(node.treeId))
  for (const [id, root] of Object.entries(draftOwners)) if (!owner.has(id)) owner.set(id, root)
  const hidden = new Set(drafts.filter(id => !owner.has(id)))
  for (const [id, root] of owner) if (id !== root) hidden.add(id)
  const cache = new WeakMap<object, any>()
  return (source) => {
    if (cache.has(source)) return cache.get(source)
    const ids = source.ids.filter(id => !hidden.has(id))
    const byId = Object.fromEntries(Object.entries(source.byId).filter(([id]) => !hidden.has(id))) as any
    for (const [id, root] of owner) {
      if (id === root || !root || !byId[root] || !source.byId[id]?.retainedBy?.mainView) continue
      byId[root] = { ...byId[root], retainedBy: { ...byId[root].retainedBy, mainView: 1 } }
    }
    const result = ids.length === source.ids.length && Object.keys(byId).length === Object.keys(source.byId).length
      && Object.keys(byId).every(id => byId[id] === source.byId[id]) ? source : { ...source, ids, byId }
    cache.set(source, result)
    return result
  }
}
