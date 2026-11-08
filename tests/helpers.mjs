import { PassThrough, Writable } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const KEYS = { up: '\x1b[A', down: '\x1b[B', space: ' ', enter: '\r', ctrlC: '\x03' }

/** A fake interactive terminal: answers each prompt from a script of [question pattern, keys]. */
export function fakeTerminal(script, { columns = 120, delay = 0, onWrite } = {}) {
  const input = new PassThrough()
  input.isTTY = true
  input.setRawMode = () => input
  let text = ''
  const output = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk
      onWrite?.(String(chunk))
      callback()
    },
  })
  output.isTTY = true
  output.columns = columns
  const asked = []
  const answer = question => {
    asked.push(question)
    const next = script.shift()
    if (!next) throw new Error(`Unexpected prompt: ${question}`)
    const [pattern, keys] = next
    if (!pattern.test(question)) throw new Error(`Expected a prompt matching ${pattern}, got: ${question}`)
    const sequence = Array.isArray(keys) ? keys : [keys]
    let index = 0
    const send = () => {
      if (index >= sequence.length) return
      input.write(sequence[index++])
      setTimeout(send, typeof delay === 'function' ? delay(sequence[index - 1]) : delay)
    }
    setTimeout(send, typeof delay === 'function' ? delay(null) : delay)
  }
  return { input, output, asked, answer, get text() { return text }, remaining: () => script.length }
}

export function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'succ-setup-home-'))
}

export function put(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

export const stripAnsi = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
