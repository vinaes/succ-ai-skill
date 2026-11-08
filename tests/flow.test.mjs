import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Writable } from 'node:stream'
import { Prompter, runSetup, main, Cancelled } from '../skills/succ-ai/scripts/succ-setup.mjs'
import { startMockServer, TEST_KEY } from '../tools/mock-server.mjs'
import { fakeTerminal, tempHome, put, KEYS, stripAnsi } from './helpers.mjs'

const versions = { claude: '2.1.319', codex: '0.154.0', opencode: '1.17.13', omp: '18.18.1', pi: '0.83.0', 'claude-app': null }
const detect = async () => versions
const codexInstructions = async () => ({ base_instructions: 'native instructions' })
const read = file => fs.readFileSync(file, 'utf8')
const typed = text => [...text]

function seedHome(home) {
  put(path.join(home, '.config/opencode/opencode.json'), JSON.stringify({ model: 'anthropic/claude', provider: { other: { name: 'Other' } } }, null, 2))
  put(path.join(home, '.claude/settings.json'), JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash(ls)'] } }, null, 2))
  put(path.join(home, '.omp/agent/models.yml'), 'providers:\n    local:\n        baseUrl: http://localhost:1234/v1\n')
  put(path.join(home, '.codex/config.toml'), 'model = "gpt-5"\n\n[model_providers.other]\nname = "Other"\n')
}

test('full interactive setup writes approved files only and never leaks the key', async () => {
  const server = await startMockServer()
  const home = tempHome()
  seedHome(home)
  const claudeBefore = read(path.join(home, '.claude/settings.json'))
  const terminal = fakeTerminal([
    [/Which tools/, [KEYS.up, KEYS.space, KEYS.enter]],
    [/API key/, [...typed('wrong-key'), KEYS.enter]],
    [/API key/, [...typed(TEST_KEY), KEYS.enter]],
    [/Models for Claude Code/, [KEYS.enter]],
    [/How should Claude Code/, [KEYS.enter]],
    [/Start Claude Code with/, [KEYS.enter]],
    [/Models for Codex/, [KEYS.enter]],
    [/Start Codex with/, [KEYS.down, KEYS.enter]],
    [/Models for OpenCode/, [KEYS.space, KEYS.enter]],
    [/Start OpenCode with/, [KEYS.enter]],
    [/Models for Oh My Pi/, [KEYS.enter]],
    [/Start Oh My Pi with/, [KEYS.enter]],
    [/Models for Pi/, ['a', 'a', KEYS.space, KEYS.enter]],
    [/Start Pi with/, [KEYS.enter]],
    [/Apply these changes/, 'y'],
    [/read-only checks/, 'n'],
  ])
  const ui = new Prompter({ input: terminal.input, output: terminal.output, color: true })
  ui.onPrompt = terminal.answer
  try {
    const result = await runSetup({ ui, origin: server.origin, env: {}, home, detect, codexInstructions })
    assert.equal(terminal.remaining(), 0)
    assert.equal(result.skipped.length, 0)
    const out = stripAnsi(terminal.text)
    assert.ok(!terminal.text.includes(TEST_KEY), 'key never reaches the terminal output')
    assert.match(out, /That key was rejected \(HTTP 401\)/)
    assert.match(out, /Claude Desktop .*Gateway/s)

    // Network: GET only, key only on /v1/models.
    assert.ok(server.requests.length >= 3)
    for (const request of server.requests) {
      assert.equal(request.method, 'GET')
      assert.ok(['/api/models', '/v1/models'].includes(request.path), request.path)
      assert.equal(request.authorized, request.path === '/v1/models')
    }

    // Claude: launch profile only; the user's settings.json is untouched.
    assert.equal(read(path.join(home, '.claude/settings.json')), claudeBefore)
    const launch = JSON.parse(read(path.join(home, '.claude/succ.settings.json')))
    assert.equal(launch.env.ANTHROPIC_AUTH_TOKEN, TEST_KEY)
    assert.equal(launch.env.ANTHROPIC_BASE_URL, server.origin)
    assert.equal(launch.env.ANTHROPIC_DEFAULT_MODEL, launch.availableModels[0])

    // Codex: other tables kept, provider added, catalog has native instructions, start command picks the second model.
    const toml = read(path.join(home, '.codex/config.toml'))
    assert.ok(toml.startsWith('model = "gpt-5"\n\n[model_providers.other]\nname = "Other"\n\n[model_providers.succ]\n'))
    assert.match(toml, new RegExp(`experimental_bearer_token = "${TEST_KEY}"`))
    const catalog = JSON.parse(read(path.join(home, '.codex/succ-models.json')))
    assert.ok(catalog.models.every(row => row.base_instructions === 'native instructions'))
    assert.match(out, new RegExp(`--model ${catalog.models[1].slug}`))

    // OpenCode: first model deselected; defaults and other provider kept; key in auth.json only.
    const opencode = JSON.parse(read(path.join(home, '.config/opencode/opencode.json')))
    assert.equal(opencode.model, 'anthropic/claude')
    assert.deepEqual(opencode.provider.other, { name: 'Other' })
    assert.ok(!('succ-apex' in opencode.provider.succ.models))
    assert.ok(!read(path.join(home, '.config/opencode/opencode.json')).includes(TEST_KEY))
    assert.deepEqual(JSON.parse(read(path.join(home, '.local/share/opencode/auth.json'))).succ, { type: 'api', key: TEST_KEY })

    // Oh My Pi: inserted at the file's own indent, other provider kept.
    const yml = read(path.join(home, '.omp/agent/models.yml'))
    assert.ok(yml.startsWith('providers:\n    succ:\n      baseUrl: '))
    assert.match(yml, /\n    local:\n        baseUrl: http:\/\/localhost:1234\/v1\n$/)

    // Pi: 'a' twice selects all again, space drops the first.
    const pi = JSON.parse(read(path.join(home, '.pi/agent/models.json')))
    assert.equal(pi.providers.succ.apiKey, TEST_KEY)
    assert.ok(!pi.providers.succ.models.some(model => model.id === 'succ-apex'))

    // Backups for every updated file.
    for (const file of ['.config/opencode/opencode.json', '.omp/agent/models.yml', '.codex/config.toml']) {
      const dir = path.dirname(path.join(home, file))
      assert.ok(fs.readdirSync(dir).some(name => name.startsWith(`${path.basename(file)}.succ-backup-`)), file)
    }
    assert.ok(!fs.readdirSync(path.join(home, '.claude')).some(name => name.includes('succ-temp')))

    if (process.platform !== 'win32') {
      for (const file of ['.claude/succ.settings.json', '.codex/config.toml', '.local/share/opencode/auth.json', '.pi/agent/models.json', '.omp/agent/models.yml']) {
        assert.equal(fs.statSync(path.join(home, file)).mode & 0o777, 0o600, file)
      }
    } else {
      const acl = execFileSync('icacls', [path.join(home, '.claude', 'succ.settings.json')], { encoding: 'utf8' })
      const entries = acl.split(/\r?\n/).filter(line => line.includes(':(')).length
      assert.equal(entries, 1, acl)
    }
  } finally {
    await server.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('dry run reads catalogs and writes nothing', async () => {
  const server = await startMockServer()
  const home = tempHome()
  const terminal = fakeTerminal([
    [/Which tools/, [KEYS.down, KEYS.down, KEYS.space, KEYS.enter]],
    [/API key/, [...typed(TEST_KEY), KEYS.enter]],
    [/Models for OpenCode/, [KEYS.enter]],
    [/Start OpenCode with/, [KEYS.enter]],
  ])
  const ui = new Prompter({ input: terminal.input, output: terminal.output, color: false })
  ui.onPrompt = terminal.answer
  try {
    await runSetup({ ui, origin: server.origin, env: {}, home, detect: async () => ({}), codexInstructions, dryRun: true })
    assert.equal(terminal.remaining(), 0)
    assert.deepEqual(fs.readdirSync(home), [])
    assert.match(terminal.text, /Dry run: nothing was written/)
  } finally {
    await server.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('without a key only OpenCode is configured; declining the plan writes nothing', async () => {
  const server = await startMockServer()
  const home = tempHome()
  const terminal = fakeTerminal([
    [/Which tools/, [KEYS.enter]],
    [/API key/, [KEYS.enter]],
    [/Continue without a key/, 'y'],
    [/Models for OpenCode/, [KEYS.enter]],
    [/Start OpenCode with/, [KEYS.enter]],
    [/Apply these changes/, KEYS.enter],
  ])
  const ui = new Prompter({ input: terminal.input, output: terminal.output, color: false })
  ui.onPrompt = terminal.answer
  try {
    const result = await runSetup({ ui, origin: server.origin, env: {}, home, detect, codexInstructions })
    assert.equal(result.applied, false)
    assert.deepEqual(result.skipped.map(([client]) => client.id), ['claude', 'codex', 'omp', 'pi'])
    assert.match(terminal.text, /run \/connect, choose Other, enter succ/)
    assert.deepEqual(fs.readdirSync(home), [])
    assert.ok(server.requests.every(request => !request.authorized))
  } finally {
    await server.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('Ctrl+C cancels cleanly', async () => {
  const server = await startMockServer()
  const terminal = fakeTerminal([[/Which tools/, KEYS.ctrlC]])
  const ui = new Prompter({ input: terminal.input, output: terminal.output, color: false })
  ui.onPrompt = terminal.answer
  try {
    await assert.rejects(runSetup({ ui, origin: server.origin, env: {}, home: tempHome(), detect, codexInstructions }), Cancelled)
  } finally {
    await server.close()
  }
})

test('setup refuses to run without an interactive terminal; models works for agents', async () => {
  const server = await startMockServer()
  let out = ''
  let err = ''
  const sink = write => new Writable({ write(chunk, _e, callback) { write(String(chunk)); callback() } })
  try {
    const code = await main(['setup'], { stdin: { isTTY: false }, stdout: sink(text => { out += text }), stderr: sink(text => { err += text }), env: { SUCC_SETUP_ORIGIN: server.origin } })
    assert.equal(code, 2)
    assert.match(err, /needs an interactive terminal/)
    assert.equal(server.requests.length, 0)
    const json = await main(['models', '--protocol', 'messages', '--json'], { stdout: sink(text => { out += text }), env: { SUCC_SETUP_ORIGIN: server.origin } })
    assert.equal(json, 0)
    const listed = JSON.parse(out)
    assert.ok(listed.models.length > 0 && listed.models.every(model => model.protocols.includes('messages')))
    assert.ok(!listed.models.some(model => model.id === 'succ-zero'))
  } finally {
    await server.close()
  }
})
