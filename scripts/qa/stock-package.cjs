// Windows: node scripts/qa/stock-package.cjs <package.tgz or linked plugin directory> [DSH install directory]
const assert = require('node:assert/strict')
const { createHash, randomUUID } = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { once } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')
const { pathToFileURL } = require('node:url')

async function freePort() {
  const server = net.createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function main() {
  assert.ok(process.argv[2], '请输入 .tgz 文件或本地插件目录')
  const source = fs.realpathSync.native(process.argv[2])
  const linked = fs.statSync(source).isDirectory()
  assert.ok(linked || source.endsWith('.tgz'))
  const launcher = process.env.PATH.split(path.delimiter)
    .map(dir => path.join(dir, 'dsh.cmd')).find(file => fs.existsSync(file))
  assert.ok(process.argv[3] || launcher, '请将 DSH 安装目录作为第二个参数传入')
  const install = process.argv[3] || path.resolve(path.dirname(launcher), '../../../..')
  const exe = path.join(install, 'DeepSeek Harness.exe')
  const modules = path.join(install, 'resources/app.asar/dsh/node_modules/@deepseek-ai')
  const cli = ['--expose-internals', path.join(modules, 'dsh-desktop-host/lib/cli.js')]
  assert.ok(fs.existsSync(exe), '请将 DSH 安装目录作为第二个参数传入')
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-stock-package-')))
  console.log('隔离验收目录', root)
  if (linked) console.log('本地链接', source)
  else console.log('安装包 SHA-256', createHash('sha256').update(fs.readFileSync(source)).digest('hex'))
  const childEnv = {
    ...process.env,
    DSH_HOME: path.join(root, 'home'), DSH_QA_SESSIONS: path.join(root, 'home/sessions'),
    DSH_QA_OUTPUT: path.join(root, 'model'), DSH_QA_DOCUMENTS: path.join(root, 'documents'),
    DSH_QA_LOG: path.join(root, 'web.log'), STUDY_MOCK_API_KEY: 'local-test',
    USERPROFILE: path.join(root, 'user'), APPDATA: path.join(root, 'roaming'),
    LOCALAPPDATA: path.join(root, 'local'), PNPM_HOME: path.join(root, 'pnpm'),
    NPM_CONFIG_USERCONFIG: path.join(root, '.npmrc'), TMP: root, TEMP: root,
    DSH_QA_READ_FIXTURE: path.join(root, 'documents/deepseek-harness/default-workspace/stock-read.txt'),
  }
  const officialEnv = { ...childEnv, ELECTRON_RUN_AS_NODE: '1' }
  for (const dir of [childEnv.DSH_QA_DOCUMENTS, childEnv.DSH_QA_OUTPUT, childEnv.USERPROFILE]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  function run(program, args, env, output = 'inherit') {
    const result = spawnSync(program, args, { cwd: root, env, stdio: output, encoding: 'utf8', windowsHide: true })
    if (result.error) throw result.error
    assert.equal(result.status, 0, result.stderr || path.basename(program) + ' 退出失败')
    return result.stdout
  }
  assert.equal(run(exe, [...cli, '--version'], officialEnv, 'pipe').trim(), '0.2.2-rc.5')
  // Desktop creates its editable profile with these same bundled helpers on first launch.
  const moduleUrl = name => JSON.stringify(pathToFileURL(path.join(modules, name, 'lib/index.js')).href)
  run(exe, ['--expose-internals', '--input-type=module', '-e',
    `import {initProfile, resolveProfileDir} from ${moduleUrl('dsh-app-boot')};
     import {PROFILE_TEMPLATES} from ${moduleUrl('dsh-official-bundles')};
     initProfile(resolveProfileDir('desktop'), PROFILE_TEMPLATES.web.bundles)`,
  ], officialEnv)
  for (const profile of ['desktop', 'web']) {
    run(exe, [...cli, 'plugin', '--profile', profile, 'add', linked ? 'link:' + source.replaceAll('\\', '/') : source], officialEnv)
    const dir = path.join(childEnv.DSH_HOME, 'profiles', profile)
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json')))
    assert.ok(manifest.dsh.profile.bundles.includes('dsh-study-tree'))
    assert.match(manifest.dependencies['dsh-study-tree'], linked ? /^link:/ : /^file:/)
    const installed = fs.realpathSync.native(path.join(dir, 'node_modules/dsh-study-tree'))
    if (linked) assert.equal(installed, source)
    else assert.ok(installed.startsWith(root + path.sep))
  }
  run(exe, [...cli, 'plugin', '--profile', 'web', 'add',
    '@deepseek-ai/dsh-experimental-client-ui-stats@0.2.2-rc.5'], officialEnv)
  const welcome = '- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n'
  fs.writeFileSync(path.join(childEnv.DSH_HOME, 'profiles/web/cordis.patch.yml'), welcome)
  const mockPort = await freePort()
  const patch = path.join(root, 'model.patch.yml')
  const model = fs.readFileSync(path.join(__dirname, 'model.patch.yml'), 'utf8')
  fs.writeFileSync(patch, model.replace('127.0.0.1:54382', '127.0.0.1:' + mockPort) +
    '\n- id: session-title-llm\n  disabled: true\n')
  function start(program, args, env, log) {
    const out = fs.openSync(path.join(root, log + '.log'), 'w')
    const err = fs.openSync(path.join(root, log + '.err'), 'w')
    try {
      return spawn(program, args, { cwd: childEnv.DSH_QA_DOCUMENTS, env, stdio: ['ignore', out, err], windowsHide: true })
    } finally {
      fs.closeSync(out)
      fs.closeSync(err)
    }
  }
  async function stop(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const stopped = once(child, 'exit')
    child.kill()
    await stopped
  }
  const mock = start(process.execPath, [path.join(__dirname, 'mock-model.cjs')],
    { ...childEnv, DSH_QA_MOCK_PORT: String(mockPort) }, 'mock')
  let host
  try {
    const port = await freePort()
    const web = [...cli, 'web', '--patch', patch, '--no-open', '--port', String(port)]
    async function boot() {
      host = start(exe, web, officialEnv, 'web')
      for (let attempt = 0; attempt < 200; attempt++) {
        if (host.exitCode !== null) throw new Error('宿主启动失败，请查看临时目录中的 web.err')
        if (/http:\/\/\S+/.test(fs.readFileSync(childEnv.DSH_QA_LOG, 'utf8'))) {
          const failures = fs.readFileSync(path.join(root, 'web.err'), 'utf8').split('\n')
            .filter(line => /failed to import|SyntaxError:|TypeError:/.test(line))
          assert.equal(failures.join('\n'), '', '宿主启动报告包含插件加载错误\n' + failures.join('\n'))
          return
        }
        await delay(100)
      }
      throw new Error('宿主未打印访问地址')
    }
    await boot()
    run(process.execPath, [path.join(__dirname, 'session-paths.cjs')], childEnv)
    run(process.execPath, [path.join(__dirname, 'large-layout.cjs')], childEnv)
    run(process.execPath, [path.join(__dirname, 'stock-restart.cjs'), 'seed'], childEnv)
    await stop(host)
    await boot()
    run(process.execPath, [path.join(__dirname, 'stock-restart.cjs'), 'restore'], childEnv)
    fs.writeFileSync(childEnv.DSH_QA_READ_FIXTURE, 'stock tool read\n')
    for (const test of ['native-views', 'native-turns', 'native-reload', 'native-questions',
      'native-approvals', 'selection-navigation', 'workspace-selection', 'material-cards']) {
      run(process.execPath, [path.join(__dirname, test + '.cjs')], childEnv)
    }
    const url = new URL(fs.readFileSync(childEnv.DSH_QA_LOG, 'utf8').match(/http:\/\/\S+/)[0])
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    const bootstrap = await fetch(url, { redirect: 'manual' })
    const cookie = bootstrap.headers.get('set-cookie')?.split(';', 1)[0]
    assert.ok(cookie, '测试宿主未签发登录 Cookie')
    const workspace = fs.mkdtempSync(path.join(childEnv.DSH_QA_DOCUMENTS, 'create-'))
    const method = 'workspace/create'
    const response = await fetch(new URL('/api/' + method, url), {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args: { request: { path: workspace } } } }),
    })
    assert.equal(response.status, 200, method + ' HTTP ' + response.status)
    const { result } = await response.json()
    assert.equal(result.ok, true, result.error?.message)
    assert.equal(result.value.created, true)
    assert.ok(result.value.workspace.workspaceId)
    assert.equal(fs.realpathSync.native(result.value.workspace.path), fs.realpathSync.native(workspace))
    console.log('workspace/create 返回 HTTP 200，并创建了测试工作区。')
  } finally {
    await stop(host)
    await stop(mock)
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
