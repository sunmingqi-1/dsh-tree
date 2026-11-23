import type { Material } from './tree'

type Fields = Pick<Material, 'content' | 'language' | 'mark'>
type Draft = {
  base: Material
  changes: Partial<Fields>
  timer?: ReturnType<typeof setTimeout>
  saving?: Promise<Material>
}

// A canvas card can leave the viewport while a write is in flight. Keep its
// pending edits with the study, and serialize revisions against the last ACK.
export class MaterialDrafts {
  private entries = new Map<string, Draft>()
  constructor(private persist: (node: Material) => Promise<Material>, private report: (error: Error) => void) {}
  read(node: Material): Material {
    const entry = this.entries.get(node.id)
    return entry ? { ...entry.base, ...entry.changes } : node
  }
  edit(node: Material, changes: Partial<Fields>) {
    const entry = this.entries.get(node.id) ?? { base: node, changes: {} } as Draft
    Object.assign(entry.changes, changes)
    this.entries.set(node.id, entry)
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => this.commit(node), 650)
  }
  commit(node: Material) { void this.flush(node).catch(this.report) }
  async flush(node: Material): Promise<Material> {
    const entry = this.entries.get(node.id)
    if (!entry) return node
    clearTimeout(entry.timer)
    if (entry.saving) return entry.saving
    entry.saving = (async () => {
      while (Object.keys(entry.changes).length) {
        const batch = { ...entry.changes }
        entry.base = await this.persist({ ...entry.base, ...batch })
        for (const key of Object.keys(batch) as (keyof Fields)[]) {
          if (entry.changes[key] === batch[key]) delete entry.changes[key]
        }
      }
      this.entries.delete(node.id)
      return entry.base
    })()
    try { return await entry.saving }
    finally { entry.saving = undefined }
  }
}
