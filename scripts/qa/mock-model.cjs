const http = require('node:http'),
  fs = require('node:fs'),
  path = require('node:path')
const output =
  process.env.DSH_QA_OUTPUT || path.join(require('node:os').tmpdir(), 'dsh-study-tree-qa')
fs.mkdirSync(output, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
http
  .createServer(async (req, res) => {
    try {
      let raw = ''
      for await (const c of req) raw += c
      const b = JSON.parse(raw || '{}'),
        messages = b.messages || [],
        all = JSON.stringify(messages)
      if (b.tools?.length)
        fs.writeFileSync(
          path.join(output, 'native-tool-schema.json'),
          JSON.stringify(b.tools || []),
        )
      fs.appendFileSync(path.join(output, 'native-requests.jsonl'), JSON.stringify(messages) + '\n')
      const msg = {
        id: 'native_' + Date.now(),
        type: 'message',
        role: 'assistant',
        model: b.model || 'mock',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 30, output_tokens: 0 },
      }
      if (!b.stream) {
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            ...msg,
            content: [{ type: 'text', text: '流式单轮验收' }],
            stop_reason: 'end_turn',
          }),
        )
        return
      }
      res.setHeader('content-type', 'text/event-stream')
      const emit = (type, data) =>
        res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n')
      emit('message_start', { message: msg })
      emit('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } })
      emit('content_block_delta', {
        index: 0,
        delta: { type: 'thinking_delta', thinking: '先检查请求所属轮次，再展示结果。' },
      })
      emit('content_block_stop', { index: 0 })
      const chunks = async (text, index = 1) => {
        emit('content_block_start', { index, content_block: { type: 'text', text: '' } })
        for (const piece of text.match(/.{1,12}/gs) || []) {
          if (res.destroyed) return
          emit('content_block_delta', { index, delta: { type: 'text_delta', text: piece } })
          await sleep(160)
        }
        emit('content_block_stop', { index })
      }
      const tool = async (name, input) => {
        await chunks('我会先检查真实文件，再继续说明。')
        emit('content_block_start', {
          index: 2,
          content_block: { type: 'tool_use', id: 'call-native-' + name, name, input: {} },
        })
        emit('content_block_delta', {
          index: 2,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
        })
        emit('content_block_stop', { index: 2 })
        emit('message_delta', {
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 25 },
        })
        emit('message_stop', {})
        res.end()
      }
      const used = (name) =>
        messages.some(
          (m) =>
            Array.isArray(m.content) &&
            m.content.some((c) => c.type === 'tool_use' && c.name === name),
        )
      if (JSON.stringify(messages.at(-1)).includes('acting as a compaction engine')) {
        await chunks('QA_COMPACT_CHECKPOINT')
        emit('message_delta', {
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 5 },
        })
        emit('message_stop', {})
        res.end()
        return
      }
      if (all.includes('卡片提问验收') && !used('ask_user_question')) {
        await tool('ask_user_question', {
          questions: [
            {
              id: 'study-path',
              header: '学习路线',
              question: '先学习架构还是工具调用？',
              options: [
                { label: '整体架构', description: '先了解完整运行流程。' },
                { label: '工具调用', description: '直接学习工具。' },
              ],
            },
          ],
        })
        return
      }
      if (all.includes('工具流式验收') && !used('read')) {
        await tool('read', {
          file_path: process.env.DSH_QA_READ_FIXTURE || path.resolve(__dirname, '../../package.json'),
          limit: 3,
        })
        return
      }
      if (all.includes('卡片权限验收') && !used('pwsh')) {
        await tool('pwsh', {
          description: '输出隔离测试标记',
          command: 'Write-Output native-card-approval',
          sandbox_permissions: 'danger-full-access',
          justification: '仅验证卡片内的原生权限面板，输出测试标记。',
        })
        return
      }
      await chunks('### 原生流式回答\n\n第一段已经到达。这段内容应当在本轮结束前显示。\n\n')
      await sleep(1200)
      await chunks(
        '第二段正在追加：**运行循环**会逐步执行模型与工具。\n\n```js\nconst turn = "streaming";\n```\n\n',
      )
      await sleep(1200)
      await chunks('第三段是最终结果。本轮结束后才显示继续提问输入框。')
      emit('message_delta', {
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 140 },
      })
      emit('message_stop', {})
      res.end()
    } catch (e) {
      res.statusCode = 500
      res.end(e.message)
    }
  })
  .listen(Number(process.env.DSH_QA_MOCK_PORT || 54382), '127.0.0.1')
