// Records a real run of `succ-setup setup` against the loopback mock server and renders it
// as an animated SVG terminal (assets/demo.svg). Nothing touches your real config: the run
// uses a throwaway home folder and the test key.
//
//   node tools/record-demo.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Prompter, runSetup } from '../skills/succ-ai/scripts/succ-setup.mjs'
import { startMockServer, TEST_KEY } from './mock-server.mjs'
import { fakeTerminal, KEYS, put } from '../tests/helpers.mjs'

const COLUMNS = 100
const ROWS = 26
const out = new URL('../assets/demo.svg', import.meta.url)

// ---------------------------------------------------------------- record

const server = await startMockServer()
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'succ-demo-'))
put(path.join(home, '.config/opencode/opencode.json'), JSON.stringify({ model: 'anthropic/claude', provider: { other: { name: 'Other' } } }, null, 2))
put(path.join(home, '.codex/config.toml'), 'model = "gpt-5"\n')

const started = Date.now()
const chunks = []
const pace = key => (key === null ? 900 : key === KEYS.enter ? 650 : key.length === 1 && key !== ' ' && key !== 'y' ? 28 : 380)
const terminal = fakeTerminal([
  [/Which tools/, [KEYS.down, KEYS.down, KEYS.down, KEYS.space, KEYS.enter]],
  [/API key/, [...TEST_KEY, KEYS.enter]],
  [/Models for Claude Code/, [KEYS.down, KEYS.down, KEYS.enter]],
  [/How should Claude Code/, [KEYS.enter]],
  [/Start Claude Code with/, [KEYS.enter]],
  [/Models for Codex/, [KEYS.enter]],
  [/Start Codex with/, [KEYS.down, KEYS.down, KEYS.down, KEYS.enter]],
  [/Models for OpenCode/, [KEYS.enter]],
  [/Start OpenCode with/, [KEYS.enter]],
  [/Apply these changes/, 'y'],
  [/read-only checks/, 'y'],
], { columns: COLUMNS, delay: pace, onWrite: text => chunks.push([Date.now() - started, text]) })

const ui = new Prompter({ input: terminal.input, output: terminal.output, color: true })
ui.onPrompt = terminal.answer
const versions = { claude: '2.1.319', codex: '0.154.0', opencode: '1.17.13', omp: '18.18.1', pi: null, 'claude-app': null }
const fakeCheck = async (command, { timeoutMs } = {}) => {
  void timeoutMs
  await new Promise(resolve => setTimeout(resolve, 700))
  const ids = JSON.parse(fs.readFileSync(new URL('../tests/fixtures/public-models.json', import.meta.url), 'utf8')).data.map(row => row.id)
  return { ok: true, stdout: ids.join('\n'), stderr: '', command }
}
await runSetup({
  ui, origin: server.origin, env: {}, home,
  detect: async () => versions,
  codexInstructions: async () => ({ base_instructions: 'native' }),
  inspect: fakeCheck,
})
chunks.push([Date.now() - started + 5000, ''])
await server.close()
fs.rmSync(home, { recursive: true, force: true })

const clean = text => text
  .replaceAll(server.origin, 'https://api.succ.ai')
  .replace(/"?(?:[A-Za-z]:)?[\\/][^\s"']*?succ-demo-[A-Za-z0-9]+([\\/][^\s"']*)?"?/g, (_m, rest = '') => `~${rest.replaceAll('\\', '/')}`)

// ---------------------------------------------------------------- terminal emulator

const blank = () => ({ ch: ' ', style: '' })
const screen = { lines: [[]], row: 0, col: 0, style: { fg: '', bold: false, dim: false } }
const styleKey = s => `${s.fg}|${s.bold ? 'b' : ''}${s.dim ? 'd' : ''}`
function sgr(params) {
  for (const code of (params || '0').split(';').map(Number)) {
    if (code === 0) screen.style = { fg: '', bold: false, dim: false }
    else if (code === 1) screen.style.bold = true
    else if (code === 2) screen.style.dim = true
    else if (code === 22) { screen.style.bold = false; screen.style.dim = false }
    else if (code === 39) screen.style.fg = ''
    else if ((code >= 30 && code <= 37) || code === 90) screen.style.fg = String(code)
  }
}
function feed(text) {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\x1b' && text[i + 1] === '[') {
      const match = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(text.slice(i))
      if (match) {
        const [all, params, op] = match
        if (op === 'm') sgr(params)
        else if (op === 'A') screen.row = Math.max(0, screen.row - Number(params || 1))
        else if (op === 'J') {
          screen.lines[screen.row] = (screen.lines[screen.row] || []).slice(0, screen.col)
          screen.lines.length = screen.row + 1
        }
        i += all.length - 1
        continue
      }
    }
    if (ch === '\n') { screen.row++; screen.col = 0; if (!screen.lines[screen.row]) screen.lines[screen.row] = []; continue }
    if (ch === '\r') { screen.col = 0; continue }
    if (screen.col >= COLUMNS) { screen.row++; screen.col = 0 }
    const line = screen.lines[screen.row] || (screen.lines[screen.row] = [])
    while (line.length < screen.col) line.push(blank())
    line[screen.col++] = { ch, style: styleKey(screen.style) }
  }
}
function snapshot() {
  const bottom = Math.max(screen.row, screen.lines.length - 1)
  const top = Math.max(0, bottom - ROWS + 1)
  const rows = []
  for (let r = top; r < top + ROWS; r++) rows.push(screen.lines[r] || [])
  return rows
}

const frames = []
for (const [time, text] of chunks) {
  feed(clean(text))
  const rows = snapshot()
  const key = JSON.stringify(rows.map(row => row.map(cell => cell.ch + cell.style)))
  const last = frames[frames.length - 1]
  if (last && last.key === key) continue
  if (last && time - last.time < 40) frames.pop()
  frames.push({ time, rows, key })
}
const total = chunks[chunks.length - 1][0]
if (process.env.DEMO_FRAMES) {
  fs.writeFileSync(process.env.DEMO_FRAMES, frames.map(frame => `--- ${frame.time}ms\n${frame.rows.map(row => row.map(cell => cell.ch).join('').trimEnd()).join('\n')}`).join('\n'))
}

// ---------------------------------------------------------------- SVG

const CHAR = 7.8
const LINE = 19
const PAD = 18
const BAR = 34
const width = Math.round(COLUMNS * CHAR + PAD * 2)
const height = ROWS * LINE + BAR + PAD
const colors = { '': '#e6edf3', 31: '#ff7b72', 32: '#3fb950', 33: '#d29922', 34: '#58a6ff', 35: '#c297ff', 36: '#56d4dd', 37: '#e6edf3', 90: '#7d8590' }
const esc = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const lineIds = new Map()
const defs = []
// Symbols outside ASCII get their own span with an explicit x, so a fallback font's
// different glyph width can never shift the columns after it.
function lineId(row) {
  const spans = []
  let current = null
  row.forEach((cell, col) => {
    const wide = cell.ch.charCodeAt(0) > 0x7e
    if (cell.ch === ' ') {
      if (current && !current.wide) current.text += ' '
      else current = null
      return
    }
    if (!current || current.style !== cell.style || wide || current.wide) {
      current = { col, style: cell.style, text: cell.ch, wide }
      spans.push(current)
      return
    }
    current.text += cell.ch
  })
  const visibleSpans = spans.map(span => ({ ...span, text: span.text.replace(/\s+$/, '') })).filter(span => span.text)
  if (!visibleSpans.length) return null
  const body = visibleSpans.map(span => {
    const [fg, flags] = span.style.split('|')
    const attrs = [`x="${(span.col * CHAR).toFixed(1)}"`, `textLength="${(span.text.length * CHAR).toFixed(1)}"`, 'lengthAdjust="spacing"']
    if (fg) attrs.push(`fill="${colors[fg]}"`)
    if (flags?.includes('b')) attrs.push('font-weight="700"')
    if (flags?.includes('d')) attrs.push('opacity=".62"')
    return `<tspan ${attrs.join(' ')}>${esc(span.text)}</tspan>`
  }).join('')
  if (!lineIds.has(body)) {
    const id = `l${lineIds.size.toString(36)}`
    lineIds.set(body, id)
    defs.push(`<text id="${id}">${body}</text>`)
  }
  return lineIds.get(body)
}

const frameGroups = frames.map((frame, index) => {
  const uses = frame.rows.map((row, r) => {
    const id = lineId(row)
    return id ? `<use href="#${id}" y="${r * LINE}"/>` : ''
  }).join('')
  return `<g transform="translate(0 ${index * ROWS * LINE})">${uses}</g>`
})

const keyframes = frames.map((frame, index) => {
  const at = Math.min(99.99, (frame.time / total) * 100)
  return `${index === 0 ? '0' : at.toFixed(3)}%{transform:translateY(${-index * ROWS * LINE}px)}`
}).join('')

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="succ-setup connecting Claude Code, Codex and OpenCode to succ.ai">
<title>succ-setup: connect Claude Code, Codex and OpenCode to succ.ai</title>
<style>
text{font:13px ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace;fill:#e6edf3;white-space:pre}
#film{animation:play ${(total / 1000).toFixed(2)}s steps(1,end) infinite}
@keyframes play{${keyframes}}
@media (prefers-reduced-motion:reduce){#film{animation:none;transform:translateY(${-(frames.length - 1) * ROWS * LINE}px)}}
</style>
<defs>${defs.join('')}<clipPath id="screen"><rect x="-2" y="-15" width="${width - PAD * 2 + 4}" height="${ROWS * LINE}"/></clipPath></defs>
<rect width="${width}" height="${height}" rx="12" fill="#0d1117"/>
<rect x=".5" y=".5" width="${width - 1}" height="${height - 1}" rx="11.5" fill="none" stroke="#30363d"/>
<circle cx="20" cy="17" r="6" fill="#ff5f57"/><circle cx="40" cy="17" r="6" fill="#febc2e"/><circle cx="60" cy="17" r="6" fill="#28c840"/>
<text x="${width / 2}" y="22" text-anchor="middle" fill="#7d8590" style="font-size:12px">node succ-setup.mjs setup</text>
<g transform="translate(${PAD} ${BAR + 18})" clip-path="url(#screen)"><g id="film">${frameGroups.join('')}</g></g>
</svg>
`
fs.writeFileSync(out, svg)
console.log(`frames ${frames.length} · ${(total / 1000).toFixed(1)}s · ${(svg.length / 1024).toFixed(0)} KB → ${fileURLPath(out)}`)
function fileURLPath(url) { return decodeURIComponent(url.pathname) }
