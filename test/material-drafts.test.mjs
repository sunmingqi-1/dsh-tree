import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('../src/client/materialDrafts.ts', import.meta.url))
const output = await build({ entryPoints: [entry], bundle: true, format: 'esm', write: false })
const { MaterialDrafts } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].contents).toString('base64'))
const node = { id: 'a', content: '', revision: 1 }

test('失焦保存期间继续输入，追问等待最后一次修改写入', async () => {
  const writes = []
  let resume
  const drafts = new MaterialDrafts(async value => {
    writes.push(value)
    if (writes.length === 1) await new Promise(resolve => { resume = resolve })
    return { ...value, revision: value.revision + 1 }
  }, assert.fail)
  drafts.edit(node, { content: 'a' })
  const blur = drafts.flush(node)
  drafts.edit(node, { content: 'ab', language: 'cpp' })
  const send = drafts.flush(node)
  resume()
  assert.deepEqual(await blur, await send)
  assert.deepEqual(writes.map(v => [v.content, v.revision]), [['a', 1], ['ab', 2]])
})

test('保存失败时保留原稿，下次提交可重试', async () => {
  let offline = true
  const drafts = new MaterialDrafts(async value => {
    if (offline) throw new Error('offline')
    return { ...value, revision: 2 }
  }, assert.fail)
  drafts.edit(node, { content: '半成品' })
  await assert.rejects(drafts.flush(node), /offline/)
  assert.equal(drafts.read(node).content, '半成品')
  offline = false
  assert.equal((await drafts.flush(node)).revision, 2)
})
