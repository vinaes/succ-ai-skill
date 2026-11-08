import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  SetupError, parseModelList, eligibleModels, normalizeModel, resolveOrigin, formatTokens,
  opencodeProvider, piProvider, ompProviderBlock, claudeLaunchSettings, codexProviderTable, codexCatalogRows, bundledInstructions,
  mergeOpencodeConfig, mergeOpencodeAuth, mergePiModels, mergeOmpModels, mergeClaudeSettings, mergeCodexConfig, mergeCodexCatalog,
} from '../skills/succ-ai/scripts/succ-setup.mjs'

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/public-models.json', import.meta.url), 'utf8'))
const { models } = parseModelList(fixture)
const ORIGIN = 'https://api.succ.ai'
const KEY = 'sk-unit-key'
const byId = id => models.find(model => model.id === id)

test('origin override accepts only loopback http', () => {
  assert.equal(resolveOrigin(undefined), 'https://api.succ.ai')
  assert.equal(resolveOrigin('http://127.0.0.1:8787'), 'http://127.0.0.1:8787')
  for (const bad of ['https://evil.example', 'http://10.0.0.1', 'http://127.0.0.1:1/path', 'http://user:pw@127.0.0.1', 'https://127.0.0.1']) {
    assert.throws(() => resolveOrigin(bad), SetupError, bad)
  }
})

test('catalog parsing keeps valid rows and reports broken ones', () => {
  assert.equal(models.length, fixture.data.length)
  const broken = parseModelList({ object: 'list', data: [...fixture.data.slice(0, 2), { id: 'x', context_window: 10, max_output_tokens: 20, thinking: false, vision: false, reasoning_efforts: [] }, fixture.data[0]] })
  assert.equal(broken.models.length, 2)
  assert.deepEqual(broken.invalid, ['x', fixture.data[0].id])
  assert.equal(normalizeModel({ ...fixture.data[0], thinking: false }), null, 'efforts without thinking are invalid')
  assert.throws(() => parseModelList({ data: [] }), SetupError)
  assert.equal(formatTokens(1048576), '1M')
  assert.equal(formatTokens(262144), '262K')
})

test('eligibility needs the protocol flag in both catalogs and agreeing metadata', () => {
  const pub = models
  assert.ok(!eligibleModels(pub, null, 'chat').eligible.some(model => model.id === 'succ-zero'), 'unavailable model excluded')
  const own = pub.filter(model => model.id !== 'succ-apex').map(model => (model.id === 'succ-cyber' ? { ...model, context_window: 1 } : model))
  const result = eligibleModels(pub, own, 'messages')
  assert.ok(!result.eligible.some(model => model.id === 'succ-apex'))
  assert.equal(result.excluded.find(item => item.id === 'succ-apex').reason, 'not allowed for this key')
  assert.ok(result.excluded.find(item => item.id === 'succ-cyber').discrepancy)
})

test('client builders follow live efforts', () => {
  const lite = byId('succ-cyber-lite')
  const surge = byId('succ-surge')
  const open = opencodeProvider([surge], ORIGIN)
  assert.equal(open.options.baseURL, 'https://api.succ.ai/v1')
  assert.deepEqual(open.models['succ-surge'].variants.max, { reasoningEffort: 'max' })
  assert.deepEqual(open.models['succ-surge'].variants.none, { disabled: true })
  const pi = piProvider([lite], ORIGIN, KEY)
  assert.equal(pi.apiKey, KEY)
  assert.equal(pi.models[0].thinkingLevelMap.off, 'none')
  assert.equal(pi.models[0].thinkingLevelMap.high, null)
  const omp = ompProviderBlock([lite, byId('succ-gemma-cyber')], ORIGIN, KEY).join('\n')
  assert.match(omp, /effortMap: \{minimal: none\}/)
  assert.match(omp, /apiKey: "sk-unit-key"/)
  const launch = claudeLaunchSettings([byId('succ-apex'), lite], 'succ-apex', ORIGIN, KEY)
  assert.equal(launch.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, String(lite.context_window))
  assert.deepEqual(launch.availableModels, ['succ-apex', 'succ-cyber-lite'])
  assert.match(codexProviderTable(ORIGIN, KEY).join('\n'), /experimental_bearer_token = "sk-unit-key"/)
  assert.deepEqual(codexCatalogRows([surge])[0].supported_reasoning_levels.map(row => row.effort), surge.reasoning_efforts)
  assert.deepEqual(bundledInstructions(JSON.stringify({ models: [{ slug: 'a' }, { slug: 'b', base_instructions: 'native' }] })), { base_instructions: 'native' })
})

test('OpenCode merge keeps other providers and defaults, refuses comments', () => {
  const existing = JSON.stringify({ model: 'anthropic/x', small_model: 'y', provider: { other: { name: 'Other' }, succ: { options: { headers: { a: '1' } }, models: { 'succ-old': {}, 'succ-surge': { options: { custom: true } } } } } })
  const { text, removed } = mergeOpencodeConfig(existing, opencodeProvider([byId('succ-surge')], ORIGIN))
  const config = JSON.parse(text)
  assert.equal(config.model, 'anthropic/x')
  assert.equal(config.small_model, 'y')
  assert.deepEqual(config.provider.other, { name: 'Other' })
  assert.deepEqual(config.provider.succ.options, { headers: { a: '1' }, baseURL: 'https://api.succ.ai/v1' })
  assert.equal(config.provider.succ.models['succ-surge'].options.custom, true)
  assert.deepEqual(removed, ['succ-old'])
  assert.throws(() => mergeOpencodeConfig('{ // comment\n}', opencodeProvider([], ORIGIN)), SetupError)
  assert.equal(JSON.parse(mergeOpencodeConfig(null, opencodeProvider([], ORIGIN)).text).$schema, 'https://opencode.ai/config.json')
  assert.deepEqual(JSON.parse(mergeOpencodeAuth('{"openai":{"type":"oauth"}}', KEY)), { openai: { type: 'oauth' }, succ: { type: 'api', key: KEY } })
})

test('Pi merge replaces only the succ provider', () => {
  const existing = JSON.stringify({ providers: { local: { baseUrl: 'http://x' }, succ: { headers: { h: 1 }, models: [{ id: 'succ-surge', note: 'mine' }, { id: 'succ-gone' }] } } })
  const { text, removed } = mergePiModels(existing, piProvider([byId('succ-surge')], ORIGIN, KEY))
  const config = JSON.parse(text)
  assert.deepEqual(config.providers.local, { baseUrl: 'http://x' })
  assert.equal(config.providers.succ.headers.h, 1)
  assert.equal(config.providers.succ.models[0].note, 'mine')
  assert.deepEqual(removed, ['succ-gone'])
})

test('Oh My Pi YAML merge inserts, replaces and refuses unsafe layouts', () => {
  const block = ['succ:', '  apiKey: "k"', '  models:', '    - id: "a"']
  assert.equal(mergeOmpModels(null, block).text, 'providers:\n  succ:\n    apiKey: "k"\n    models:\n      - id: "a"\n')
  const four = '# mine\nproviders:\n    local:\n        baseUrl: http://x\nother: 1\n'
  const inserted = mergeOmpModels(four, block)
  assert.equal(inserted.text, '# mine\nproviders:\n    succ:\n      apiKey: "k"\n      models:\n        - id: "a"\n    local:\n        baseUrl: http://x\nother: 1\n')
  const again = mergeOmpModels(inserted.text, ['succ:', '  apiKey: "new"'])
  assert.equal(again.replaced, true)
  assert.equal(again.text, '# mine\nproviders:\n    succ:\n      apiKey: "new"\n    local:\n        baseUrl: http://x\nother: 1\n')
  assert.equal(mergeOmpModels('other: 1\n', block).text, 'other: 1\n\nproviders:\n  succ:\n    apiKey: "k"\n    models:\n      - id: "a"\n')
  assert.equal(mergeOmpModels('---\nproviders:\n  local: {}\n', ['succ:']).text, '---\nproviders:\n  succ:\n  local: {}\n')
  assert.equal(mergeOmpModels('a: 1\r\n', ['succ:']).text, 'a: 1\r\n\r\nproviders:\r\n  succ:\r\n')
  assert.throws(() => mergeOmpModels('providers: {}\n', block), SetupError)
  assert.throws(() => mergeOmpModels('providers:\n  succ: {baseUrl: x}\n', block), SetupError)
  assert.throws(() => mergeOmpModels('providers:\n\tlocal: 1\n', block), SetupError)
  assert.throws(() => mergeOmpModels('a: 1\n---\nb: 2\n', block), SetupError)
})

test('Claude settings merge keeps unrelated settings and refuses a second key', () => {
  const existing = JSON.stringify({ theme: 'dark', env: { FOO: '1' }, modelPicker: { options: [{ model: 'mine' }, { model: 'succ-old' }] } })
  const settings = JSON.parse(mergeClaudeSettings(existing, ORIGIN, KEY, [byId('succ-apex')]))
  assert.equal(settings.theme, 'dark')
  assert.equal(settings.env.FOO, '1')
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, KEY)
  assert.deepEqual(settings.modelPicker.options.map(option => option.model), ['mine', 'succ-apex'])
  assert.throws(() => mergeClaudeSettings(JSON.stringify({ apiKeyHelper: 'x' }), ORIGIN, KEY, []), SetupError)
  assert.throws(() => mergeClaudeSettings(JSON.stringify({ env: { ANTHROPIC_API_KEY: 'x' } }), ORIGIN, KEY, []), SetupError)
})

test('Codex config merge appends or replaces only the succ table', () => {
  const table = ['[model_providers.succ]', 'name = "succ.ai"']
  assert.equal(mergeCodexConfig(null, table).text, '[model_providers.succ]\nname = "succ.ai"\n')
  const existing = 'model = "gpt-5"\n\n[model_providers.other]\nname = "x"\n'
  const appended = mergeCodexConfig(existing, table).text
  assert.equal(appended, 'model = "gpt-5"\n\n[model_providers.other]\nname = "x"\n\n[model_providers.succ]\nname = "succ.ai"\n')
  const middle = 'model = "a"\n[model_providers.succ]\nname = "old"\nexperimental_bearer_token = "old"\n\n# about profiles\n[profiles.x]\nmodel = "b"\n'
  assert.equal(mergeCodexConfig(middle, table).text, 'model = "a"\n[model_providers.succ]\nname = "succ.ai"\n\n# about profiles\n[profiles.x]\nmodel = "b"\n')
  assert.throws(() => mergeCodexConfig('model_providers.succ.name = "x"\n', table), SetupError)
  assert.throws(() => mergeCodexConfig('[model_providers]\nsucc = { name = "x" }\n', table), SetupError)
})

test('Codex catalog merge keeps instructions and valid saved efforts', () => {
  const surge = byId('succ-surge')
  const previous = JSON.stringify({ models: [{ slug: 'succ-surge', default_reasoning_level: 'high', base_instructions: 'mine' }, { slug: 'succ-gone' }, { slug: 'custom-row' }] })
  const catalog = JSON.parse(mergeCodexCatalog(previous, codexCatalogRows([surge]), { base_instructions: 'native' }))
  assert.deepEqual(catalog.models.map(row => row.slug), ['succ-surge', 'custom-row'])
  assert.equal(catalog.models[0].default_reasoning_level, 'high')
  assert.equal(catalog.models[0].base_instructions, 'mine')
  const fresh = JSON.parse(mergeCodexCatalog(null, codexCatalogRows([surge]), { base_instructions: 'native' }))
  assert.equal(fresh.models[0].base_instructions, 'native')
  assert.equal(fresh.models[0].default_reasoning_level, null)
})

test('shell arguments are quoted for the platform shell', async () => {
  const { shellArg } = await import('../skills/succ-ai/scripts/succ-setup.mjs')
  assert.equal(shellArg('model_provider=succ', 'linux'), 'model_provider=succ')
  assert.equal(shellArg('model_catalog_json=/home/a b/x.json', 'linux'), "'model_catalog_json=/home/a b/x.json'")
  assert.equal(shellArg("it's", 'linux'), "'it'\\''s'")
  assert.equal(shellArg('C:\\Users\\A B\\x.json', 'win32'), '"C:\\Users\\A B\\x.json"')
  assert.throws(() => shellArg('a"b c', 'win32'), SetupError)
})
