// A loopback stand-in for api.succ.ai used by the tests and the demo recording.
// It serves the saved public catalog and accepts exactly one test key.
import http from 'node:http'
import fs from 'node:fs'

export const TEST_KEY = 'sk-succ-test-0000000000000000'

export async function startMockServer({ fixture = new URL('../tests/fixtures/public-models.json', import.meta.url), keyModels } = {}) {
  const publicList = JSON.parse(fs.readFileSync(fixture, 'utf8'))
  const ownList = keyModels ? keyModels(publicList) : publicList
  const requests = []
  const server = http.createServer((request, response) => {
    const auth = request.headers.authorization
    requests.push({ method: request.method, path: request.url, authorized: Boolean(auth), body: '' })
    request.on('data', chunk => { requests[requests.length - 1].body += chunk })
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (request.method !== 'GET') return send(405, { error: { code: 'method_not_allowed' } })
    if (request.url === '/api/models') return send(200, publicList)
    if (request.url === '/v1/models') {
      if (auth !== `Bearer ${TEST_KEY}`) return send(401, { error: { code: 'invalid_api_key', type: 'authentication_error', message: 'Invalid API key.' } })
      return send(200, ownList)
    }
    return send(404, { error: { code: 'not_found' } })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { origin: `http://127.0.0.1:${port}`, requests, close: () => new Promise(resolve => server.close(resolve)) }
}
