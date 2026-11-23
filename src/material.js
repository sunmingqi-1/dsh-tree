export const MATERIAL_RECORD = 'plugin:study-tree/material'
export const materialLabel = kind => kind === 'code' ? '代码' : 'Markdown'

export function markdownCardTitle(content) {
  const line = content.split(/\r?\n/).map(text => text.trim()).find(text => text && !/^(?:```|~~~)/.test(text))
  return line?.replace(/^(?:#{1,6}|>|[-*+])\s+/, '').replace(/\s+#+$/, '').slice(0, 64) || '学习笔记'
}

export function materialMarkdown(material) {
  if (material.kind !== 'code') return material.content
  let length = 3
  for (const run of material.content.matchAll(/`+/g)) length = Math.max(length, run[0].length + 1)
  const fence = '`'.repeat(length)
  return fence + (material.language || '') + '\n' + material.content + '\n' + fence
}

export function materialContext(material) {
  return '参考资料（' + materialLabel(material.kind) + '）：' + material.question + '\n\n' +
    materialMarkdown(material) + '\n\n---\n\n'
}
