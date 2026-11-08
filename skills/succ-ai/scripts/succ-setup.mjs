#!/usr/bin/env node
/*
 * succ-setup: connect coding agents to succ.ai without exposing your API key.
 *
 *   node succ-setup.mjs setup [--dry-run]
 *       Interactive. Run it yourself in a terminal: it asks for your key.
 *   node succ-setup.mjs models [--protocol chat|messages|responses] [--json]
 *       Public model list. No key and no prompts, so an agent can run it.
 *
 * Guarantees (checked by the repository tests):
 * - Network: only GET requests, only to https://api.succ.ai. Nothing is ever sent to a
 *   model, so running this script costs nothing.
 * - API key: you type it into a hidden prompt. The script sends it only as the
 *   Authorization header of GET /v1/models and writes it only to the files you approve.
 *   It never prints or logs the key, never puts it in a command argument, and never
 *   passes it to another program.
 * - Files: nothing is written until you confirm the plan. Every replaced file gets a
 *   backup first. Writes are atomic and owner-only, and linked or foreign-owned paths
 *   are refused.
 * - No dependencies and no telemetry. Requires Node.js 18 or later.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import readline from 'node:readline'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const VERSION = '0.1.0'
export const DEFAULT_ORIGIN = 'https://api.succ.ai'
const KEYS_PAGE = 'https://succ.ai/dashboard/keys'
const GUIDE = 'https://succ.ai/agent-setup.md'

export class SetupError extends Error {}
export class Cancelled extends Error {}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const pretty = value => `${JSON.stringify(value, null, 2)}\n`

// ---------------------------------------------------------------- origin

export function resolveOrigin(value) {
  if (value === undefined || value === '') return DEFAULT_ORIGIN
  let url
  try {
    url = new URL(value)
  } catch {
    throw new SetupError('SUCC_SETUP_ORIGIN is not a URL.')
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (!loopback || url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new SetupError('SUCC_SETUP_ORIGIN may only name a loopback test server, such as http://127.0.0.1:8787.')
  }
  return url.origin
}

// ---------------------------------------------------------------- catalog

export const PROTOCOLS = {
  chat: { flag: 'available', label: 'Chat Completions', endpoint: '/v1/chat/completions' },
  messages: { flag: 'messages_available', label: 'Messages', endpoint: '/v1/messages' },
  responses: { flag: 'responses_available', label: 'Responses', endpoint: '/v1/responses' },
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
const OPTIONAL_FLAGS = ['available', 'messages_available', 'responses_available', 'tools', 'parallel_tool_calls', 'structured_output']

export function normalizeModel(row) {
  if (!isObject(row) || typeof row.id !== 'string' || !MODEL_ID.test(row.id)) return null
  const positive = value => Number.isSafeInteger(value) && value > 0
  if (!positive(row.context_window) || !positive(row.max_output_tokens) || row.max_output_tokens > row.context_window) return null
  if (typeof row.thinking !== 'boolean' || typeof row.vision !== 'boolean') return null
  if (!OPTIONAL_FLAGS.every(flag => row[flag] === undefined || typeof row[flag] === 'boolean')) return null
  if (row.max_images !== undefined && !(Number.isSafeInteger(row.max_images) && row.max_images >= 0)) return null
  const efforts = row.reasoning_efforts
  if (!Array.isArray(efforts) || !efforts.every(effort => typeof effort === 'string' && effort.trim() === effort && effort !== '')) return null
  if (new Set(efforts).size !== efforts.length || (!row.thinking && efforts.length > 0)) return null
  const name = typeof row.display_name === 'string' && row.display_name.trim() ? row.display_name.trim() : row.id
  return {
    id: row.id,
    name,
    available: row.available === true,
    messages_available: row.messages_available === true,
    responses_available: row.responses_available === true,
    context_window: row.context_window,
    max_output_tokens: row.max_output_tokens,
    thinking: row.thinking,
    vision: row.vision,
    tools: row.tools === true,
    parallel_tool_calls: row.parallel_tool_calls === true,
    structured_output: row.structured_output === true,
    max_images: row.max_images ?? 0,
    reasoning_efforts: [...efforts],
    service_tiers: Array.isArray(row.supported_service_tiers) ? row.supported_service_tiers.filter(tier => typeof tier === 'string') : [],
  }
}

export function parseModelList(value) {
  if (!isObject(value) || value.object !== 'list' || !Array.isArray(value.data)) throw new SetupError('The model list is not in the expected format.')
  const models = []
  const invalid = []
  const seen = new Set()
  for (const row of value.data) {
    const model = normalizeModel(row)
    if (!model || seen.has(model.id)) {
      invalid.push(typeof row?.id === 'string' ? row.id : '(unnamed)')
      continue
    }
    seen.add(model.id)
    models.push(model)
  }
  return { models, invalid, revision: Number.isSafeInteger(value.catalog_revision) ? value.catalog_revision : null }
}

const COMPARED = ['context_window', 'max_output_tokens', 'thinking', 'vision', 'tools', 'parallel_tool_calls', 'structured_output', 'max_images']

export function sameMetadata(a, b, flag) {
  return COMPARED.every(field => a[field] === b[field]) && a[flag] === b[flag] && a.reasoning_efforts.join('\n') === b.reasoning_efforts.join('\n')
}

/** Models a client may use: protocol flag true in the public list and, when a key was checked, in the key's list with matching metadata. */
export function eligibleModels(publicModels, keyModels, protocol) {
  const { flag, label } = PROTOCOLS[protocol]
  const own = keyModels ? new Map(keyModels.map(model => [model.id, model])) : null
  const eligible = []
  const excluded = []
  for (const model of publicModels) {
    if (!model[flag]) {
      excluded.push({ id: model.id, reason: `${label} is unavailable right now` })
      continue
    }
    if (own) {
      const allowed = own.get(model.id)
      if (!allowed) {
        excluded.push({ id: model.id, reason: 'not allowed for this key' })
        continue
      }
      if (!sameMetadata(model, allowed, flag)) {
        excluded.push({ id: model.id, reason: 'public and key catalogs disagree', discrepancy: true })
        continue
      }
    }
    eligible.push(model)
  }
  return { eligible, excluded }
}

export async function getJSON(origin, pathname, key, { timeoutMs = 15000 } = {}) {
  const headers = { accept: 'application/json', 'user-agent': `succ-setup/${VERSION}` }
  if (key) headers.authorization = `Bearer ${key}`
  let response
  try {
    response = await fetch(`${origin}${pathname}`, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    throw new SetupError(error?.name === 'TimeoutError' ? `${pathname} did not answer in time.` : `Could not reach ${origin}${pathname}.`)
  }
  const type = response.headers.get('content-type') || ''
  let body = null
  if (type.includes('application/json')) {
    try {
      body = await response.json()
    } catch {
      body = null
    }
  } else {
    await response.body?.cancel()
  }
  if (!response.ok) {
    const code = typeof body?.error?.code === 'string' ? body.error.code : typeof body?.code === 'string' ? body.code : null
    const error = new SetupError(`${pathname} returned HTTP ${response.status}${code ? ` (${code})` : ''}.`)
    error.status = response.status
    error.code = code
    throw error
  }
  if (body === null) throw new SetupError(`${pathname} did not return JSON.`)
  return body
}

export function formatTokens(value) {
  return value >= 999_500 ? `${+(value / 1_000_000).toFixed(1)}M` : `${Math.round(value / 1000)}K`
}

export function describeModel(model) {
  const parts = [`${formatTokens(model.context_window)} context`, `${formatTokens(model.max_output_tokens)} output`]
  parts.push(model.reasoning_efforts.length ? `effort ${model.reasoning_efforts.join('/')}` : model.thinking ? 'fixed reasoning' : 'no reasoning')
  if (model.vision) parts.push('images')
  return parts.join(' · ')
}

// ---------------------------------------------------------------- clients

export const CLIENTS = [
  { id: 'claude', name: 'Claude Code', protocol: 'messages', command: 'claude' },
  { id: 'codex', name: 'Codex', protocol: 'responses', command: 'codex' },
  { id: 'opencode', name: 'OpenCode', protocol: 'chat', command: 'opencode' },
  { id: 'omp', name: 'Oh My Pi', protocol: 'chat', command: 'omp' },
  { id: 'pi', name: 'Pi', protocol: 'chat', command: 'pi' },
  { id: 'claude-app', name: 'Claude Desktop', protocol: 'messages', command: null },
]

const VARIANT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export function opencodeProvider(models, origin) {
  return {
    npm: '@ai-sdk/openai-compatible',
    name: 'succ.ai',
    options: { baseURL: `${origin}/v1` },
    models: Object.fromEntries(models.map(model => [model.id, {
      name: model.name,
      reasoning: model.thinking,
      modalities: { input: model.vision ? ['text', 'image'] : ['text'], output: ['text'] },
      limit: { context: model.context_window, output: model.max_output_tokens },
      options: { parallel_tool_calls: model.parallel_tool_calls },
      variants: Object.fromEntries([...new Set([...VARIANT_LEVELS, ...model.reasoning_efforts])].map(level => [
        level,
        model.reasoning_efforts.includes(level) ? { reasoningEffort: level } : { disabled: true },
      ])),
    }])),
  }
}

export function piProvider(models, origin, key) {
  return {
    baseUrl: `${origin}/v1`,
    api: 'openai-completions',
    apiKey: key,
    authHeader: true,
    compat: { supportsStore: false, maxTokensField: 'max_tokens' },
    models: models.map(model => ({
      id: model.id,
      name: model.name,
      reasoning: model.thinking,
      input: model.vision ? ['text', 'image'] : ['text'],
      contextWindow: model.context_window,
      maxTokens: model.max_output_tokens,
      thinkingLevelMap: Object.fromEntries(THINKING_LEVELS.map(level => {
        const effort = level === 'off' ? 'none' : level
        return [level, model.reasoning_efforts.includes(effort) ? effort : null]
      })),
      compat: { supportsReasoningEffort: model.reasoning_efforts.length > 0 },
    })),
  }
}

/** The `succ:` provider block for Oh My Pi models.yml, at indent 0. */
export function ompProviderBlock(models, origin, key) {
  const quote = JSON.stringify
  const lines = [
    'succ:',
    `  baseUrl: ${quote(`${origin}/v1`)}`,
    '  api: openai-completions',
    `  apiKey: ${quote(key)}`,
    '  auth: apiKey',
    '  authHeader: true',
    '  compat:',
    '    supportsStore: false',
    '    maxTokensField: max_tokens',
    '    extraBody:',
    '      parallel_tool_calls: false',
    '  models:',
  ]
  for (const model of models) {
    const efforts = THINKING_LEVELS.filter(level => level !== 'off'
      && model.reasoning_efforts.includes(level === 'minimal' && model.reasoning_efforts.includes('none') ? 'none' : level))
    lines.push(
      `    - id: ${quote(model.id)}`,
      `      name: ${quote(model.name)}`,
      `      reasoning: ${model.thinking}`,
      `      input: ${model.vision ? '[text, image]' : '[text]'}`,
      `      contextWindow: ${model.context_window}`,
      `      maxTokens: ${model.max_output_tokens}`,
    )
    if (efforts.length) {
      lines.push('      thinking:', '        mode: effort', `        efforts: ${quote(efforts)}`, '        requiresEffort: true')
      if (model.reasoning_efforts.includes('none')) lines.push('        effortMap: {minimal: none}')
    }
    lines.push('      compat:', `        supportsReasoningEffort: ${efforts.length > 0}`, `        supportsReasoningParams: ${efforts.length > 0}`)
    if (model.parallel_tool_calls) lines.push('        extraBody:', '          parallel_tool_calls: true')
  }
  return lines
}

export function claudeEnv(origin, key) {
  return { ANTHROPIC_BASE_URL: origin, ANTHROPIC_AUTH_TOKEN: key, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1', ENABLE_TOOL_SEARCH: 'false' }
}

const pickerOption = model => ({ model: model.id, label: `${model.name} / ${model.id}` })

/** Settings for `claude --settings <file>`: succ only for that launch, the user's normal Claude Code stays untouched. */
export function claudeLaunchSettings(models, defaultId, origin, key) {
  return {
    env: {
      ...claudeEnv(origin, key),
      ANTHROPIC_DEFAULT_MODEL: defaultId,
      // Process-wide for unrecognized IDs, so use the smallest selected window: never over-claims.
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(Math.min(...models.map(model => model.context_window))),
    },
    availableModels: models.map(model => model.id),
    modelPicker: { replaceBuiltInOptions: true, options: models.map(pickerOption) },
  }
}

export function claudeConflicts(settings) {
  const conflicts = []
  if (Object.hasOwn(settings, 'apiKeyHelper')) conflicts.push('apiKeyHelper')
  if (isObject(settings.env) && Object.hasOwn(settings.env, 'ANTHROPIC_API_KEY')) conflicts.push('env.ANTHROPIC_API_KEY')
  return conflicts
}

export function codexProviderTable(origin, key) {
  const quote = JSON.stringify
  return [
    '[model_providers.succ]',
    'name = "succ.ai"',
    `base_url = ${quote(`${origin}/v1`)}`,
    `experimental_bearer_token = ${quote(key)}`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'supports_websockets = false',
    'supports_standalone_web_search = false',
    'request_max_retries = 0',
    'stream_max_retries = 0',
  ]
}

export function codexCatalogRows(models) {
  return models.map((model, priority) => ({
    slug: model.id,
    display_name: model.name,
    description: null,
    default_reasoning_level: null,
    supported_reasoning_levels: model.reasoning_efforts.map(effort => ({ effort, description: effort })),
    shell_type: 'unified_exec',
    visibility: 'list',
    supported_in_api: true,
    priority,
    availability_nux: null,
    upgrade: null,
    supports_reasoning_summary_parameter: false,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: 'freeform',
    truncation_policy: { mode: 'tokens', limit: model.context_window },
    context_window: model.context_window,
    max_context_window: model.context_window,
    experimental_supported_tools: [],
    input_modalities: model.vision ? ['text', 'image'] : ['text'],
    supports_search_tool: false,
    supports_experimental_context: false,
    use_responses_lite: false,
  }))
}

function instructionsOf(row) {
  if (typeof row?.base_instructions === 'string' && row.base_instructions.trim()) return { base_instructions: row.base_instructions }
  const messages = row?.model_messages
  if (typeof messages?.instructions_template === 'string' && messages.instructions_template.trim()) {
    return { model_messages: { instructions_template: messages.instructions_template, instructions_variables: messages.instructions_variables ?? null } }
  }
  return null
}

/** Native instruction fields from `codex debug models --bundled`; Codex needs them on every catalog row. */
export function bundledInstructions(output) {
  let bundled
  try {
    bundled = JSON.parse(output)
  } catch {
    return null
  }
  return Array.isArray(bundled?.models) ? bundled.models.map(instructionsOf).find(Boolean) ?? null : null
}

// ---------------------------------------------------------------- merges

function parseJSONObject(text, label) {
  if (text === null || text === undefined || text.trim() === '') return {}
  let value
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    throw new SetupError(`${label} is not plain JSON (it has comments or a syntax error), so it was left alone.`)
  }
  if (!isObject(value)) throw new SetupError(`${label} does not contain a JSON object, so it was left alone.`)
  return value
}

export function mergeOpencodeConfig(text, provider) {
  const config = parseJSONObject(text, 'The OpenCode config')
  if (text === null || text === undefined) config.$schema = 'https://opencode.ai/config.json'
  if (config.provider !== undefined && !isObject(config.provider)) throw new SetupError('The OpenCode config has an unexpected "provider" value.')
  const existing = isObject(config.provider?.succ) ? config.provider.succ : {}
  const existingModels = isObject(existing.models) ? existing.models : {}
  const models = {}
  for (const [id, row] of Object.entries(provider.models)) {
    const previous = isObject(existingModels[id]) ? existingModels[id] : {}
    models[id] = { ...previous, ...row, options: { ...(isObject(previous.options) ? previous.options : {}), ...row.options } }
  }
  const options = { ...(isObject(existing.options) ? existing.options : {}), ...provider.options }
  config.provider = { ...config.provider, succ: { ...existing, ...provider, options, models } }
  return { text: pretty(config), removed: Object.keys(existingModels).filter(id => !(id in provider.models)) }
}

export function mergeOpencodeAuth(text, key) {
  const auth = parseJSONObject(text, 'The OpenCode credential file')
  auth.succ = { type: 'api', key }
  return pretty(auth)
}

export function mergePiModels(text, provider) {
  const config = parseJSONObject(text, 'The Pi models.json')
  if (config.providers !== undefined && !isObject(config.providers)) throw new SetupError('The Pi models.json has an unexpected "providers" value.')
  const existing = isObject(config.providers?.succ) ? config.providers.succ : {}
  const previous = new Map((Array.isArray(existing.models) ? existing.models : []).filter(row => isObject(row) && typeof row.id === 'string').map(row => [row.id, row]))
  const models = provider.models.map(row => ({ ...previous.get(row.id), ...row }))
  config.providers = { ...config.providers, succ: { ...existing, ...provider, models } }
  return { text: pretty(config), removed: [...previous.keys()].filter(id => !provider.models.some(row => row.id === id)) }
}

const indentOf = line => line.match(/^ */)[0].length

/** Adds or replaces `providers.succ` in Oh My Pi YAML without a YAML parser, refusing anything it cannot edit safely. */
export function mergeOmpModels(text, block) {
  if (text === null || text === undefined || text.trim() === '') return { text: ['providers:', ...block.map(line => `  ${line}`), ''].join('\n'), replaced: false }
  const source = text.replace(/^\uFEFF/, '')
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.split(/\r?\n/)
  if (lines.some(line => /^\s*\t/.test(line))) throw new SetupError('The Oh My Pi models file indents with tabs, so it was left alone.')
  const content = lines.findIndex(line => line.trim() && !line.trimStart().startsWith('#'))
  if (lines.some((line, index) => /^\.\.\.\s*$/.test(line) || (/^---\s*$/.test(line) && index !== content))) {
    throw new SetupError('The Oh My Pi models file has several YAML documents, so it was left alone.')
  }
  const start = lines.findIndex(line => /^providers\s*:\s*(#.*)?$/.test(line))
  if (start === -1) {
    if (lines.some(line => /^["']?providers["']?\s*:/.test(line))) throw new SetupError('The Oh My Pi models file writes "providers" inline, so it was left alone.')
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
    return { text: [...lines, '', 'providers:', ...block.map(line => `  ${line}`), ''].join(eol), replaced: false }
  }
  let end = start + 1
  while (end < lines.length && (lines[end].trim() === '' || lines[end].startsWith(' ') || lines[end].startsWith('#'))) end++
  const child = lines.slice(start + 1, end).find(line => line.trim() && !line.trimStart().startsWith('#'))
  const pad = child ? ' '.repeat(indentOf(child)) : '  '
  const named = new RegExp(`^${pad}["']?succ["']?\\s*:`)
  const plain = new RegExp(`^${pad}["']?succ["']?\\s*:\\s*(#.*)?$`)
  const at = lines.findIndex((line, index) => index > start && index < end && named.test(line))
  const indented = block.map(line => pad + line)
  if (at === -1) {
    lines.splice(start + 1, 0, ...indented)
    return { text: lines.join(eol), replaced: false }
  }
  if (!plain.test(lines[at])) throw new SetupError('The Oh My Pi "succ" provider is written inline, so it was left alone.')
  let stop = at + 1
  while (stop < end && (lines[stop].trim() === '' || indentOf(lines[stop]) > pad.length)) stop++
  while (stop > at + 1 && lines[stop - 1].trim() === '') stop--
  lines.splice(at, stop - at, ...indented)
  return { text: lines.join(eol), replaced: true }
}

export function mergeClaudeSettings(text, origin, key, models) {
  const settings = parseJSONObject(text, 'Claude Code settings.json')
  if (settings.env !== undefined && !isObject(settings.env)) throw new SetupError('Claude Code settings.json has an unexpected "env" value.')
  if (settings.modelPicker !== undefined && !isObject(settings.modelPicker)) throw new SetupError('Claude Code settings.json has an unexpected "modelPicker" value.')
  const conflicts = claudeConflicts(settings)
  if (conflicts.length) throw new SetupError(`Claude Code settings.json already sets ${conflicts.join(' and ')}. Two keys would conflict, so it was left alone.`)
  settings.env = { ...settings.env, ...claudeEnv(origin, key) }
  const picker = isObject(settings.modelPicker) ? settings.modelPicker : {}
  const kept = (Array.isArray(picker.options) ? picker.options : []).filter(option => !(isObject(option) && typeof option.model === 'string' && option.model.startsWith('succ-')))
  settings.modelPicker = { ...picker, options: [...kept, ...models.map(pickerOption)] }
  return pretty(settings)
}

/** Adds or replaces the [model_providers.succ] table in Codex config.toml, leaving every other line untouched. */
export function mergeCodexConfig(text, table) {
  const source = (text ?? '').replace(/^\uFEFF/, '')
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source === '' ? [] : source.split(/\r?\n/)
  const header = /^\s*\[\s*model_providers\s*\.\s*("succ"|succ)\s*\]\s*(#.*)?$/
  if (lines.some(line => /^\s*model_providers\s*=/.test(line) || /^\s*model_providers\s*\.\s*("succ"|succ)\s*[.=]/.test(line))) {
    throw new SetupError('Codex config.toml defines the succ provider inline, so it was left alone.')
  }
  const parent = lines.findIndex(line => /^\s*\[\s*model_providers\s*\]\s*(#.*)?$/.test(line))
  if (parent !== -1) {
    for (let index = parent + 1; index < lines.length && !/^\s*\[/.test(lines[index]); index++) {
      if (/^\s*("succ"|succ)\s*[.=]/.test(lines[index])) throw new SetupError('Codex config.toml defines the succ provider inline, so it was left alone.')
    }
  }
  const at = lines.findIndex(line => header.test(line))
  if (at === -1) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
    return { text: [...lines, ...(lines.length ? [''] : []), ...table, ''].join(eol), replaced: false }
  }
  let stop = at + 1
  while (stop < lines.length && !/^\s*\[/.test(lines[stop])) stop++
  // Comments directly above the next table header belong to that table.
  if (stop < lines.length) while (stop > at + 1 && (/^\s*#/.test(lines[stop - 1]) || lines[stop - 1].trim() === '')) stop--
  const tail = lines.slice(stop)
  while (tail.length && tail[0].trim() === '') tail.shift()
  return { text: [...lines.slice(0, at), ...table, '', ...tail].join(eol), replaced: true }
}

export function mergeCodexCatalog(text, rows, inherited) {
  const previous = text === null || text === undefined ? { models: [] } : parseJSONObject(text, 'The succ Codex catalog')
  if (!Array.isArray(previous.models)) throw new SetupError('The succ Codex catalog has no model list, so it was left alone.')
  const existing = new Map()
  for (const row of previous.models) {
    if (!isObject(row) || typeof row.slug !== 'string' || !row.slug || existing.has(row.slug)) throw new SetupError('The succ Codex catalog has an invalid row, so it was left alone.')
    existing.set(row.slug, row)
  }
  const merged = rows.map(row => {
    const old = existing.get(row.slug)
    const saved = old?.default_reasoning_level
    const keep = row.supported_reasoning_levels.some(option => option.effort === saved)
    const result = { ...old, ...row, default_reasoning_level: keep ? saved : null }
    delete result.base_instructions
    delete result.model_messages
    return { ...result, ...(instructionsOf(old) || inherited) }
  })
  for (const row of previous.models) if (!row.slug.startsWith('succ-')) merged.push(row)
  return pretty({ ...previous, models: merged })
}

// ---------------------------------------------------------------- paths and files

const exists = file => fs.existsSync(file)

export function clientPaths(id, env, home) {
  if (id === 'claude') {
    const dir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
    return { dir, settings: path.join(dir, 'settings.json'), launch: path.join(dir, 'succ.settings.json') }
  }
  if (id === 'codex') {
    const dir = env.CODEX_HOME || path.join(home, '.codex')
    return { dir, config: path.join(dir, 'config.toml'), catalog: path.join(dir, 'succ-models.json') }
  }
  if (id === 'opencode') {
    const dir = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode')
    const json = path.join(dir, 'opencode.json')
    const jsonc = path.join(dir, 'opencode.jsonc')
    const config = env.OPENCODE_CONFIG || (exists(json) || !exists(jsonc) ? json : jsonc)
    const data = path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'opencode')
    return { dir: path.dirname(config), config, authDir: data, auth: path.join(data, 'auth.json') }
  }
  if (id === 'pi') {
    const dir = env.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent')
    return { dir, models: path.join(dir, 'models.json'), auth: path.join(dir, 'auth.json') }
  }
  if (id === 'omp') {
    const overrides = ['PI_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'OMP_PROFILE', 'PI_PROFILE', 'PI_CONFIG_FILES'].filter(name => env[name])
    if (overrides.length) throw new SetupError(`An Oh My Pi profile or override is active (${overrides.join(', ')}). Configure it by hand: ${GUIDE}#oh-my-pi`)
    const dir = path.join(home, '.omp', 'agent')
    const yml = path.join(dir, 'models.yml')
    const yaml = path.join(dir, 'models.yaml')
    if (!exists(yml) && !exists(yaml) && exists(path.join(dir, 'models.json'))) {
      throw new SetupError('Oh My Pi still uses a legacy models.json. Start omp once so it migrates, then run setup again.')
    }
    return { dir, models: exists(yml) || !exists(yaml) ? yml : yaml }
  }
  throw new SetupError(`Unknown client ${id}`)
}

function lstat(target) {
  try {
    return fs.lstatSync(target)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export function readText(file) {
  const info = lstat(file)
  if (!info) return null
  if (info.isSymbolicLink() || !info.isFile()) throw new SetupError(`${file} is a link or not a regular file, so it was left alone.`)
  return fs.readFileSync(file, 'utf8')
}

function powershell(script, target) {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  execFileSync(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, SUCC_PRIVATE_PATH: target }, stdio: 'ignore', windowsHide: true })
}

function restrictWindows(target, directory) {
  const kind = directory ? 'DirectorySecurity' : 'FileSecurity'
  const info = directory ? 'DirectoryInfo' : 'FileInfo'
  const inherit = directory ? 'OICI' : ''
  powershell([
    "$ErrorActionPreference = 'Stop'",
    '$target = $env:SUCC_PRIVATE_PATH',
    '$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User',
    '$access = [Security.AccessControl.AccessControlSections]::Access',
    `$acl = [Security.AccessControl.${kind}]::new($target, $access)`,
    `$acl.SetSecurityDescriptorSddlForm(('D:P(A;${inherit};FA;;;' + $sid.Value + ')'), $access)`,
    `if ($PSVersionTable.PSEdition -eq 'Core') { [IO.FileSystemAclExtensions]::SetAccessControl([IO.${info}]::new($target), $acl) } else { ([IO.${info}]::new($target)).SetAccessControl($acl) }`,
    `$actual = [Security.AccessControl.${kind}]::new($target, $access)`,
    '$rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))',
    "if (!$actual.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value) { throw 'Private ACL verification failed' }",
  ].join('; '), target)
}

/** Creates the folder if needed and refuses links anywhere between it and the home folder. Secret folders become owner-only. */
export function prepareDirectory(dir, home, secret) {
  for (let parent = dir; ; parent = path.dirname(parent)) {
    const info = lstat(parent)
    if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new SetupError(`${parent} is a link or not a folder. Resolve it first.`)
    if (parent === home || parent === path.dirname(parent)) break
  }
  const info = lstat(dir)
  if (!info) fs.mkdirSync(dir, { recursive: true, mode: secret ? 0o700 : 0o755 })
  else if (process.platform !== 'win32' && info.uid !== process.getuid()) throw new SetupError(`${dir} belongs to another user.`)
  if (secret) {
    if (process.platform === 'win32') restrictWindows(dir, true)
    else fs.chmodSync(dir, 0o700)
  }
}

function createFile(target, content, secret, mode) {
  const descriptor = fs.openSync(target, 'wx', secret ? 0o600 : mode)
  let done = false
  try {
    if (secret && process.platform === 'win32') restrictWindows(target, false)
    fs.writeFileSync(descriptor, content)
    done = true
  } finally {
    fs.closeSync(descriptor)
    if (!done) fs.unlinkSync(target)
  }
}

/** Backup, then atomic replace. Refuses links, hard links and files owned by someone else. */
export function writeFileSafely(file, content, { secret, stamp, expected }) {
  const info = lstat(file)
  if (info && (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1)) throw new SetupError(`${file} is linked, so it was left alone.`)
  if (info && process.platform !== 'win32' && info.uid !== process.getuid()) throw new SetupError(`${file} belongs to another user.`)
  const current = info ? fs.readFileSync(file, 'utf8') : null
  if (expected !== undefined && current !== expected) throw new SetupError(`${file} changed after the plan was made, so it was left alone. Run setup again.`)
  const mode = info ? info.mode & 0o777 : 0o644
  let backup = null
  if (info) {
    backup = `${file}.succ-backup-${stamp}`
    createFile(backup, current, true, 0o600)
  }
  const temporary = `${file}.succ-temp-${stamp}`
  try {
    createFile(temporary, content, secret, mode)
    fs.renameSync(temporary, file)
  } finally {
    if (lstat(temporary)) fs.unlinkSync(temporary)
  }
  return { backup }
}

// ---------------------------------------------------------------- processes

/** Runs a fixed, argument-free command line (never user input, never the key) and captures its output. */
export function runCommand(commandLine, { cwd, env, timeoutMs = 20000 } = {}) {
  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(commandLine, { shell: true, cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve({ ok: false, stdout, stderr })
      return
    }
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', chunk => { if (stdout.length < 64 * 1024 * 1024) stdout += chunk })
    child.stderr.on('data', chunk => { if (stderr.length < 1024 * 1024) stderr += chunk })
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, stdout, stderr }) })
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, stdout, stderr }) })
  })
}

export async function detectClients(env, home) {
  const found = await Promise.all(CLIENTS.map(async client => {
    if (!client.command) {
      const installed = process.platform === 'darwin'
        ? exists('/Applications/Claude.app') || exists(path.join(home, 'Applications', 'Claude.app'))
        : process.platform === 'win32' && Boolean(env.LOCALAPPDATA) && exists(path.join(env.LOCALAPPDATA, 'AnthropicClaude'))
      return [client.id, installed ? 'installed' : null]
    }
    const result = await runCommand(`${client.command} --version`, { env, timeoutMs: 15000 })
    if (!result.ok) return [client.id, null]
    return [client.id, result.stdout.match(/\d+\.\d+\.\d+[^\s)]*/)?.[0] ?? 'installed']
  }))
  return Object.fromEntries(found)
}

export async function codexBundledInstructions(env) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'succ-codex-'))
  try {
    const result = await runCommand('codex debug models --bundled', { cwd: temporary, env: { ...env, CODEX_HOME: temporary }, timeoutMs: 30000 })
    return result.ok ? bundledInstructions(result.stdout) : null
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

/** Quotes one shell argument for the platform's default shell (cmd/PowerShell on Windows, sh elsewhere). */
export function shellArg(value, platform = process.platform) {
  if (/^[A-Za-z0-9._/:=@+-]+$/.test(value)) return value
  if (platform === 'win32') {
    if (/["%!^&|<>]/.test(value)) throw new SetupError(`Cannot quote ${value} safely for this shell.`)
    return `"${value}"`
  }
  return `'${value.replaceAll("'", "'\\''")}'`
}

const slashes = file => file.split(path.sep).join('/')
const codexOverrides = catalog => `-c model_provider=succ -c ${shellArg(`model_catalog_json=${slashes(catalog)}`)}`

// Read-only, non-generating inspections. Each lists models from the saved configuration.
const CHECKS = {
  opencode: () => 'opencode models succ',
  omp: () => 'omp models succ --json --no-extensions',
  pi: () => 'pi --offline --no-extensions --no-mcp --list-models succ',
  codex: plan => `codex debug models ${codexOverrides(plan.paths.catalog)}`,
}

// ---------------------------------------------------------------- terminal UI

const ESC = '\x1b['

export function palette(enabled) {
  const wrap = (open, close) => text => (enabled ? `${ESC}${open}m${text}${ESC}${close}m` : String(text))
  return {
    bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39),
    blue: wrap(34, 39), magenta: wrap(35, 39), cyan: wrap(36, 39), gray: wrap(90, 39),
  }
}

const visible = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

function fit(text, width) {
  if (visible(text).length <= width) return text
  let out = ''
  let count = 0
  for (const part of text.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    if (part.startsWith('\x1b[')) { out += part; continue }
    for (const char of part) {
      if (count >= width - 1) return `${out}…${ESC}0m`
      out += char
      count++
    }
  }
  return out
}

export class Prompter {
  constructor({ input = process.stdin, output = process.stdout, color = true } = {}) {
    this.input = input
    this.output = output
    this.c = palette(color)
    this.drawn = 0
    this.onPrompt = null
    readline.emitKeypressEvents(input)
  }

  get width() {
    return Math.max(40, (this.output.columns || 100) - 1)
  }

  line(text = '') {
    this.output.write(`${text}\n`)
  }

  draw(lines) {
    if (this.drawn) this.output.write(`${ESC}${this.drawn}A\r${ESC}J`)
    this.output.write(lines.map(line => fit(line, this.width)).join('\n') + '\n')
    this.drawn = lines.length
  }

  settle(line) {
    this.draw([line])
    this.drawn = 0
  }

  keys(question, handler) {
    return new Promise((resolve, reject) => {
      const raw = typeof this.input.setRawMode === 'function'
      const finish = (callback, value) => {
        this.input.off('keypress', listener)
        if (raw) this.input.setRawMode(false)
        this.input.pause()
        callback(value)
      }
      const listener = (text, key = {}) => {
        if (key.ctrl && (key.name === 'c' || key.name === 'd')) return finish(reject, new Cancelled())
        handler(text, key, value => finish(resolve, value))
      }
      if (raw) this.input.setRawMode(true)
      this.input.on('keypress', listener)
      this.input.resume()
      this.onPrompt?.(question)
    })
  }

  async choose(question, options, { multi = false, initial = [], hint } = {}) {
    const { c } = this
    const chosen = new Set(initial)
    const size = Math.min(options.length, 10)
    const labelWidth = Math.max(...options.map(option => visible(option.label).length))
    let cursor = 0
    let top = 0
    let warning = ''
    const help = hint ?? (multi ? 'space toggles · a toggles all · enter confirms' : '↑↓ to move · enter to pick')
    const render = () => {
      if (cursor < top) top = cursor
      if (cursor >= top + size) top = cursor - size + 1
      const lines = [`${c.cyan('?')} ${c.bold(question)}  ${warning ? c.yellow(warning) : c.gray(help)}`]
      for (let index = top; index < top + size; index++) {
        const option = options[index]
        const pointer = index === cursor ? c.cyan('❯') : ' '
        const mark = multi ? (chosen.has(index) ? c.green('◉') : c.gray('◯')) + ' ' : ''
        const label = index === cursor ? c.cyan(option.label) : option.label
        lines.push(`${pointer} ${mark}${label}${' '.repeat(labelWidth - visible(option.label).length)}  ${c.gray(option.detail ?? '')}`)
      }
      if (options.length > size) lines.push(c.gray(`  ${top + 1}–${top + size} of ${options.length}`))
      this.draw(lines)
    }
    this.output.write(`${ESC}?25l`)
    render()
    try {
      return await this.keys(question, (text, key, done) => {
        warning = ''
        if (key.name === 'up' || text === 'k') cursor = (cursor - 1 + options.length) % options.length
        else if (key.name === 'down' || text === 'j') cursor = (cursor + 1) % options.length
        else if (multi && key.name === 'space') chosen.has(cursor) ? chosen.delete(cursor) : chosen.add(cursor)
        else if (multi && text === 'a') {
          if (chosen.size === options.length) chosen.clear()
          else options.forEach((_, index) => chosen.add(index))
        } else if (key.name === 'return' || key.name === 'enter') {
          if (multi && chosen.size === 0) warning = 'pick at least one'
          else {
            const picked = multi ? [...chosen].sort((a, b) => a - b) : [cursor]
            const summary = picked.length > 4 ? `${picked.length} selected` : picked.map(index => visible(options[index].label).trim()).join(', ')
            this.settle(`${c.green('✔')} ${c.bold(question)}  ${c.cyan(summary)}`)
            done(multi ? picked.map(index => options[index].value) : options[cursor].value)
            return
          }
        }
        render()
      })
    } finally {
      this.output.write(`${ESC}?25h`)
    }
  }

  async confirm(question, preset = false) {
    const { c } = this
    this.draw([`${c.cyan('?')} ${c.bold(question)}  ${c.gray(preset ? 'Y/n' : 'y/N')}`])
    return this.keys(question, (text, key, done) => {
      const lower = (text || '').toLowerCase()
      let answer = null
      if (lower === 'y') answer = true
      else if (lower === 'n') answer = false
      else if (key.name === 'return' || key.name === 'enter') answer = preset
      if (answer === null) return
      this.settle(`${c.green('✔')} ${c.bold(question)}  ${c.cyan(answer ? 'yes' : 'no')}`)
      done(answer)
    })
  }

  async secret(question) {
    const { c } = this
    let value = ''
    const render = () => this.draw([`${c.cyan('?')} ${c.bold(question)}  ${value ? c.gray('•'.repeat(Math.min(value.length, 16))) : c.gray('hidden · enter to skip')}`])
    render()
    return this.keys(question, (text, key, done) => {
      if (key.name === 'return' || key.name === 'enter') {
        this.settle(`${c.green('✔')} ${c.bold(question)}  ${c.cyan(value ? 'received (hidden)' : 'skipped')}`)
        done(value)
        return
      }
      if (key.name === 'backspace') value = value.slice(0, -1)
      else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text)) value += text
      render()
    })
  }
}

// ---------------------------------------------------------------- setup flow

function planClient(client, { models, choice, key, origin, paths, inherited, env }) {
  const files = []
  const notes = []
  let start = null
  if (client.id === 'claude') {
    const settingsText = readText(paths.settings)
    const settings = parseJSONObject(settingsText, 'Claude Code settings.json')
    const conflicts = claudeConflicts(settings)
    if (conflicts.length) throw new SetupError(`Claude Code settings.json already sets ${conflicts.join(' and ')}. Two keys would conflict; remove it or follow ${GUIDE}#claude-cli.`)
    if (env.ANTHROPIC_API_KEY) notes.push('ANTHROPIC_API_KEY is set in this shell and may override the succ key. Unset it before starting.')
    if (choice.mode === 'launch') {
      files.push({ path: paths.launch, content: pretty(claudeLaunchSettings(models, choice.defaultId, origin, key)), secret: true, what: `launch profile · ${models.length} models · key` })
      start = `claude --settings ${shellArg(paths.launch)} --model ${choice.defaultId}`
      if (models.length > 1) notes.push(`Context limit set to the smallest selected window (${formatTokens(Math.min(...models.map(model => model.context_window)))}).`)
    } else {
      files.push({ path: paths.settings, content: mergeClaudeSettings(settingsText, origin, key, models), secret: true, what: `env + model picker · ${models.length} models · key`, expected: settingsText })
      start = 'claude   (then /model)'
      notes.push('Every Claude Code session now uses succ.ai until you remove the env entries.')
    }
  } else if (client.id === 'codex') {
    if (!inherited) throw new SetupError('Codex needs its bundled model instructions (codex debug models --bundled), which could not be read. Is Codex installed and up to date?')
    const configText = readText(paths.config)
    const catalogText = readText(paths.catalog)
    files.push({ path: paths.config, content: mergeCodexConfig(configText, codexProviderTable(origin, key)).text, secret: true, what: 'provider "succ" · key', expected: configText })
    files.push({ path: paths.catalog, content: mergeCodexCatalog(catalogText, codexCatalogRows(models), inherited), secret: false, what: `model catalog · ${models.length} models`, expected: catalogText })
    start = `codex ${codexOverrides(paths.catalog)} -c web_search=disabled --model ${choice.defaultId}`
    notes.push('Default Codex provider and model unchanged; the start command selects succ.')
  } else if (client.id === 'opencode') {
    const configText = readText(paths.config)
    const merged = mergeOpencodeConfig(configText, opencodeProvider(models, origin))
    files.push({ path: paths.config, content: merged.text, secret: false, what: `provider "succ" · ${models.length} models`, expected: configText })
    if (merged.removed.length) notes.push(`Removes models no longer available: ${merged.removed.join(', ')}.`)
    if (key) {
      const authText = readText(paths.auth)
      files.push({ path: paths.auth, content: mergeOpencodeAuth(authText, key), secret: true, dir: paths.authDir, what: 'credential "succ" · key', expected: authText })
    } else {
      notes.push('No key saved. In OpenCode run /connect, choose Other, enter succ, then paste your key.')
    }
    if (env.OPENCODE_CONFIG_CONTENT || env.OPENCODE_CONFIG_DIR) notes.push('Another OpenCode config layer is active (OPENCODE_CONFIG_CONTENT or OPENCODE_CONFIG_DIR) and may override this file.')
    start = `opencode --model succ/${choice.defaultId}`
  } else if (client.id === 'pi') {
    const modelsText = readText(paths.models)
    const merged = mergePiModels(modelsText, piProvider(models, origin, key))
    files.push({ path: paths.models, content: merged.text, secret: true, what: `provider "succ" · ${models.length} models · key`, expected: modelsText })
    const auth = readText(paths.auth)
    if (auth && /"succ"\s*:/.test(auth)) notes.push('Pi auth.json also has a "succ" entry, which takes precedence. Remove it if it holds an old key.')
    start = `pi --provider succ --model ${choice.defaultId}`
  } else if (client.id === 'omp') {
    const modelsText = readText(paths.models)
    const merged = mergeOmpModels(modelsText, ompProviderBlock(models, origin, key))
    files.push({ path: paths.models, content: merged.text, secret: true, what: `provider "succ" · ${models.length} models · key`, expected: modelsText })
    start = `omp --model succ/${choice.defaultId}`
  }
  return { files, notes, start }
}

function claudeDesktopSteps(origin) {
  return [
    'Open Help → Troubleshooting → Enable Developer Mode, then Developer → Configure Third-Party Inference.',
    `Connection: Gateway · base URL ${origin} (no /v1) · paste your key into Gateway API key · Static API key · Bearer.`,
    'Leave the model list empty so the app discovers your models, then Apply Changes → Save & Restart.',
    'After restart, start in third-party mode and pick a succ model. Each surface (Chat, Cowork, Code) is separate.',
  ]
}

export async function runSetup(options) {
  const written = []
  try {
    return await setupFlow(options, written)
  } catch (error) {
    if (error instanceof Cancelled) error.written = written.length
    throw error
  }
}

async function setupFlow({ ui, origin = DEFAULT_ORIGIN, env = process.env, home = os.homedir(), dryRun = false, detect = detectClients, codexInstructions = codexBundledInstructions, inspect = runCommand, now = () => new Date() }, written) {
  const { c } = ui
  const show = file => (file.startsWith(home) ? `~${file.slice(home.length)}` : file).replaceAll('\\', '/')
  ui.line(`${c.magenta('◆')} ${c.bold('succ.ai setup')} ${c.gray(`v${VERSION}`)}`)
  ui.line(c.gray('  Connects your coding tools to succ.ai. Reads model lists only: no prompt, no charge.'))
  ui.line()

  const versions = await detect(env, home)
  const clientOptions = CLIENTS.map(client => ({
    label: client.name,
    detail: client.id === 'claude-app' ? (versions[client.id] ? 'installed · guided steps' : 'guided steps') : versions[client.id] ? `v${versions[client.id]}` : 'not found',
    value: client.id,
  }))
  const initial = CLIENTS.map((client, index) => (client.id !== 'claude-app' && versions[client.id] ? index : -1)).filter(index => index >= 0)
  const selectedIds = await ui.choose('Which tools should use succ.ai?', clientOptions, { multi: true, initial })
  const selected = CLIENTS.filter(client => selectedIds.includes(client.id))

  let publicList = parseModelList(await getJSON(origin, '/api/models'))
  ui.line(`${c.green('✔')} Public catalog  ${c.gray(`${publicList.models.length} text models${publicList.revision ? ` · revision ${publicList.revision}` : ''}`)}`)

  let key = null
  let keyList = null
  if (selected.some(client => client.id !== 'claude-app')) {
    ui.line(c.gray(`  Your key stays here; only a free GET /v1/models checks it. New key: ${KEYS_PAGE}`))
    for (let attempt = 1; attempt <= 3 && key === null; attempt++) {
      const typed = (await ui.secret('succ.ai API key')).trim()
      if (!typed) {
        if (await ui.confirm('Continue without a key? Only OpenCode can be set up, and key permissions are not checked.', false)) break
        continue
      }
      try {
        keyList = parseModelList(await getJSON(origin, '/v1/models', typed))
        key = typed
        const aliases = keyList.models.filter(model => !publicList.models.some(row => row.id === model.id)).length
        ui.line(`${c.green('✔')} Key accepted  ${c.gray(`${keyList.models.length - aliases} models allowed${aliases ? ` · ${aliases} Claude Desktop aliases` : ''}`)}`)
      } catch (error) {
        if (error.status === 401 || error.status === 403) ui.line(`${c.red('✖')} That key was rejected (HTTP ${error.status}). Use the full key, not its public ID.`)
        else throw error
      }
    }
  }

  const eligibility = () => Object.fromEntries(selected.filter(client => client.id !== 'claude-app').map(client => [client.id, eligibleModels(publicList.models, keyList?.models ?? null, client.protocol)]))
  let lists = eligibility()
  if (Object.values(lists).some(list => list.excluded.some(item => item.discrepancy))) {
    publicList = parseModelList(await getJSON(origin, '/api/models'))
    if (key) keyList = parseModelList(await getJSON(origin, '/v1/models', key))
    lists = eligibility()
  }

  const choices = {}
  const skipped = []
  for (const client of selected) {
    if (client.id === 'claude-app') continue
    if (!key && client.id !== 'opencode') {
      skipped.push([client, 'needs an API key'])
      continue
    }
    const { eligible, excluded } = lists[client.id]
    ui.line()
    ui.line(`${c.magenta('◆')} ${c.bold(client.name)}  ${c.gray(`${PROTOCOLS[client.protocol].label} API · ${eligible.length} models available${excluded.length ? ` · ${excluded.length} excluded` : ''}`)}`)
    if (!eligible.length) {
      skipped.push([client, 'no models are available for its protocol'])
      continue
    }
    const models = await ui.choose(`Models for ${client.name}`, eligible.map(model => ({ label: model.name, detail: `${model.id} · ${describeModel(model)}`, value: model })), { multi: true, initial: eligible.map((_, index) => index) })
    const choice = { models, defaultId: models[0].id, mode: 'launch' }
    if (client.id === 'claude') {
      choice.mode = await ui.choose('How should Claude Code use succ.ai?', [
        { label: 'Start command only', detail: 'recommended · your normal Claude Code stays as it is', value: 'launch' },
        { label: 'Every session', detail: 'adds succ to your user settings.json', value: 'global' },
      ])
    }
    if (models.length > 1 && !(client.id === 'claude' && choice.mode === 'global')) {
      choice.defaultId = await ui.choose(`Start ${client.name} with`, models.map(model => ({ label: model.name, detail: model.id, value: model.id })))
    }
    choices[client.id] = choice
  }

  const inherited = choices.codex ? await codexInstructions(env) : null
  const plans = []
  for (const client of selected) {
    if (!choices[client.id]) continue
    try {
      const paths = clientPaths(client.id, env, home)
      plans.push({ client, paths, ...planClient(client, { models: choices[client.id].models, choice: choices[client.id], key, origin, paths, inherited, env }) })
    } catch (error) {
      if (!(error instanceof SetupError)) throw error
      skipped.push([client, error.message])
    }
  }

  ui.line()
  ui.line(`${c.magenta('◆')} ${c.bold('Plan')}`)
  for (const plan of plans) {
    plan.files.forEach((file, index) => {
      const verb = readText(file.path) === null ? c.green('create') : c.yellow('update')
      ui.line(`  ${(index ? '' : plan.client.name).padEnd(14)} ${verb} ${show(file.path)}  ${c.gray(file.what)}`)
    })
    for (const note of plan.notes) ui.line(`  ${''.padEnd(14)} ${c.gray(`· ${note}`)}`)
  }
  for (const [client, reason] of skipped) ui.line(`  ${client.name.padEnd(14)} ${c.yellow('skip')}   ${c.gray(reason)}`)
  if (selected.some(client => client.id === 'claude-app')) ui.line(`  ${'Claude Desktop'.padEnd(14)} ${c.cyan('steps')}  ${c.gray('shown at the end; the app stores your key itself')}`)
  ui.line(c.gray('  Unchanged: default models, other providers, logins, permissions, budgets and ZDR.'))
  ui.line(c.gray('  Updated files are backed up first. Files holding the key are readable only by you.'))
  ui.line()

  if (plans.length && !dryRun) {
    if (!(await ui.confirm('Apply these changes?', false))) {
      ui.line(c.gray('Nothing was written.'))
      return { written, plans, skipped, applied: false }
    }
    const stamp = `${now().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`
    for (const plan of plans) {
      try {
        const prepared = new Set()
        for (const file of plan.files) {
          const dir = file.dir ?? path.dirname(file.path)
          const marker = `${dir}\0${file.secret}`
          if (!prepared.has(marker)) prepareDirectory(dir, home, file.secret)
          prepared.add(marker)
        }
        const backups = plan.files.map(file => writeFileSafely(file.path, file.content, { secret: file.secret, stamp, expected: file.expected }).backup).filter(Boolean)
        written.push(...plan.files.map(file => file.path))
        ui.line(`${c.green('✔')} ${plan.client.name.padEnd(14)} ${c.gray(`saved${backups.length ? ` · backup ${backups.map(file => path.basename(file)).join(', ')}` : ''}`)}`)
      } catch (error) {
        if (!(error instanceof SetupError) && !error.code) throw error
        ui.line(`${c.red('✖')} ${plan.client.name.padEnd(14)} ${error instanceof SetupError ? error.message : `could not write (${error.code})`}`)
        plan.failed = true
      }
    }
    const checkable = plans.filter(plan => !plan.failed && CHECKS[plan.client.id])
    if (checkable.length && await ui.confirm('Run read-only checks now? They list models and send no prompts.', true)) {
      for (const plan of checkable) {
        const result = await inspect(CHECKS[plan.client.id](plan), { env, timeoutMs: 60000 })
        const ids = choices[plan.client.id].models.map(model => model.id)
        const seen = ids.filter(id => result.stdout.includes(id)).length
        ui.line(result.ok
          ? `${seen === ids.length ? c.green('✔') : c.yellow('!')} ${plan.client.name.padEnd(14)} ${c.gray(`lists ${seen} of ${ids.length} succ models`)}`
          : `${c.yellow('!')} ${plan.client.name.padEnd(14)} ${c.gray('check could not run with this version; open the tool and look at its model list')}`)
      }
    }
  } else if (dryRun) {
    ui.line(c.gray('Dry run: nothing was written.'))
  }

  const done = plans.filter(plan => !plan.failed)
  if (done.length || selected.some(client => client.id === 'claude-app')) {
    ui.line()
    ui.line(`${c.magenta('◆')} ${c.bold(dryRun ? 'Start commands after setup' : 'Start')}`)
    for (const plan of done) ui.line(`  ${plan.client.name.padEnd(14)} ${c.cyan(plan.start)}`)
    if (selected.some(client => client.id === 'claude-app')) {
      ui.line(`  ${'Claude Desktop'.padEnd(14)} ${c.gray('in the app:')}`)
      claudeDesktopSteps(origin).forEach((step, index) => ui.line(`  ${''.padEnd(14)} ${c.gray(`${index + 1}. ${step}`)}`))
    }
  }
  ui.line()
  ui.line(c.gray('No prompt was sent. Requests you make in these tools use your succ.ai credit.'))
  return { written, plans, skipped, applied: !dryRun }
}

// ---------------------------------------------------------------- models command

export async function modelsCommand({ origin, protocol, asJSON, write = text => process.stdout.write(text) }) {
  if (protocol && !PROTOCOLS[protocol]) throw new SetupError('--protocol must be chat, messages or responses.')
  const list = parseModelList(await getJSON(origin, '/api/models'))
  const models = protocol ? list.models.filter(model => model[PROTOCOLS[protocol].flag]) : list.models
  if (asJSON) {
    write(pretty({
      source: `${origin}/api/models`,
      revision: list.revision,
      note: 'Public availability only. A key can be limited to fewer models; check GET /v1/models with the user\'s key or run "setup --dry-run".',
      models: models.map(model => ({
        id: model.id, name: model.name,
        protocols: Object.keys(PROTOCOLS).filter(name => model[PROTOCOLS[name].flag]),
        context_window: model.context_window, max_output_tokens: model.max_output_tokens,
        thinking: model.thinking, reasoning_efforts: model.reasoning_efforts, vision: model.vision, max_images: model.max_images,
        tools: model.tools, parallel_tool_calls: model.parallel_tool_calls, structured_output: model.structured_output, service_tiers: model.service_tiers,
      })),
      invalid: list.invalid,
    }))
    return
  }
  const rows = models.map(model => [model.id, model.name, Object.keys(PROTOCOLS).filter(name => model[PROTOCOLS[name].flag]).join(',') || 'unavailable', describeModel(model)])
  const widths = [0, 1, 2].map(column => Math.max(...rows.map(row => row[column].length), 4))
  for (const row of rows) write(`${row[0].padEnd(widths[0])}  ${row[1].padEnd(widths[1])}  ${row[2].padEnd(widths[2])}  ${row[3]}\n`)
  if (list.invalid.length) write(`Skipped invalid rows: ${list.invalid.join(', ')}\n`)
}

// ---------------------------------------------------------------- main

const HELP = `succ-setup ${VERSION}: connect coding tools to succ.ai

  setup [--dry-run]     Interactive. Run it yourself in a terminal; it asks for your API key.
                        --dry-run shows what your key can use and what would change, writing nothing.
  models [--protocol chat|messages|responses] [--json]
                        Public model list. No key needed.

Only GET requests to ${DEFAULT_ORIGIN}. Nothing is sent to a model. Guide: ${GUIDE}
`

export async function main(argv, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  const [command = 'help', ...rest] = argv
  const flag = name => rest.includes(name)
  const value = name => {
    const index = rest.indexOf(name)
    return index >= 0 ? rest[index + 1] : undefined
  }
  if (typeof fetch !== 'function') throw new SetupError('Node.js 18 or later is required.')
  const origin = resolveOrigin(env.SUCC_SETUP_ORIGIN)
  if (command === 'models') {
    await modelsCommand({ origin, protocol: value('--protocol'), asJSON: flag('--json'), write: text => stdout.write(text) })
    return 0
  }
  if (command === 'setup') {
    if (!stdin.isTTY || !stdout.isTTY) {
      stderr.write('setup asks for your API key, so it needs an interactive terminal.\nRun it yourself, for example in a separate terminal window:\n\n')
      stderr.write(`  node "${fileURLToPath(import.meta.url)}" setup\n\n`)
      stderr.write('On Windows use PowerShell or Windows Terminal (Git Bash/mintty is not interactive for Node).\n')
      return 2
    }
    const color = !env.NO_COLOR && env.TERM !== 'dumb'
    await runSetup({ ui: new Prompter({ input: stdin, output: stdout, color }), origin, env, dryRun: flag('--dry-run') })
    return 0
  }
  if (command === 'version' || command === '--version') {
    stdout.write(`${VERSION}\n`)
    return 0
  }
  stdout.write(HELP)
  return command === 'help' || command === '--help' || command === '-h' ? 0 : 1
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code
  }, error => {
    if (error instanceof Cancelled) {
      process.stdout.write(`${ESC}?25h\nCancelled.${error.written ? '' : ' Nothing was written.'}\n`)
      process.exitCode = 130
    } else {
      process.stderr.write(`${error instanceof SetupError ? error.message : `Unexpected error: ${error?.message ?? error}`}\n`)
      process.exitCode = 1
    }
  })
}
