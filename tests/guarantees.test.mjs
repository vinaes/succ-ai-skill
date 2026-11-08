// Static checks for the promises made at the top of succ-setup.mjs and in the README.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../skills/succ-ai/scripts/succ-setup.mjs', import.meta.url), 'utf8')
const code = source.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')

test('one network call site, GET only, no redirects', () => {
  assert.equal(code.match(/\bfetch\(/g).length, 1)
  assert.match(code, /fetch\(`\$\{origin\}\$\{pathname\}`, \{ method: 'GET', headers, redirect: 'error'/)
  assert.doesNotMatch(code, /\b(POST|PUT|PATCH|DELETE)\b/)
  assert.doesNotMatch(code, /\bhttps?\.request\b|\bnet\.connect\b|XMLHttpRequest|WebSocket/)
})

test('only fixed command lines are executed', () => {
  const calls = [...code.matchAll(/\b(?:runCommand|inspect)\(([^,)]+)/g)].map(match => match[1].trim())
  assert.match(code, /inspect = runCommand,/, 'the injectable check runner defaults to runCommand')
  assert.deepEqual(calls.slice(1), ['`${client.command} --version`', "'codex debug models --bundled'", 'CHECKS[plan.client.id](plan'])
  assert.doesNotMatch(code, /\bexec\(|execSync\(/)
  assert.equal(code.match(/execFileSync\(/g).length, 1, 'only the PowerShell ACL helper')
})

test('no telemetry, analytics or third-party hosts', () => {
  const hosts = [...source.matchAll(/https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*)/gi)].map(match => match[1].toLowerCase())
  for (const host of hosts) assert.ok(['api.succ.ai', 'succ.ai', 'opencode.ai', '127.0.0.1'].includes(host), host)
})

test('the key is interpolated only into the Authorization header', () => {
  assert.equal(code.match(/\$\{\s*key\s*\}/g).length, 1)
  assert.match(code, /headers\.authorization = `Bearer \$\{key\}`/)
  assert.doesNotMatch(code, /\$\{\s*typed\s*\}/)
  assert.doesNotMatch(code, /console\.(log|error)/, 'all output goes through the prompter or explicit streams')
  for (const call of code.matchAll(/\b(spawn|execFileSync|runCommand)\([^\n]*/g)) {
    assert.doesNotMatch(call[0], /\b(key|typed)\b/, 'no child process receives the key')
  }
})
