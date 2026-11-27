import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SOCKET_LIMIT, parseDynamicPorts, recordSocketState, summarizeNetstat } from './socket-state.mjs'

// Synthetic netstat rows only.
const netstat = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       900
  TCP    127.0.0.1:51105        0.0.0.0:0              LISTENING       4100
  TCP    127.0.0.1:51106        127.0.0.1:51105        TIME_WAIT       0
  TCP    127.0.0.1:51107        127.0.0.1:51105        TIME_WAIT       0
  TCP    127.0.0.1:51108        127.0.0.1:51105        ESTABLISHED     4200
  TCP    10.1.0.4:50000         203.0.113.7:443        ESTABLISHED     4300
  TCP    [::]:135               [::]:0                 LISTENING       900
`

test('a socket-limit failure is told from other navigation failures (#1810)', () => {
  assert.ok(SOCKET_LIMIT.test('page.goto: net::ERR_NO_BUFFER_SPACE at http://127.0.0.1:51105/?t=synthetic'))
  assert.ok(SOCKET_LIMIT.test('page.goto: net::ERR_ADDRESS_IN_USE at http://127.0.0.1:1/'))
  assert.ok(!SOCKET_LIMIT.test('page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:1/'))
  assert.ok(!SOCKET_LIMIT.test('Timeout 30000ms exceeded.'))
})

test('the netstat summary counts loopback sockets by state and owner (#1810)', () => {
  assert.deepEqual(summarizeNetstat(netstat), {
    total: 7,
    byState: { LISTENING: 3, TIME_WAIT: 2, ESTABLISHED: 2 },
    loopback: { TIME_WAIT: 2, ESTABLISHED: 1 },
    topOwners: [{ pid: 0, sockets: 2 }, { pid: 4200, sockets: 1 }],
  })
  assert.deepEqual(parseDynamicPorts('Protocol tcp Dynamic Port Range\n---------------------------------\nStart Port      : 49152\nNumber of Ports : 16384\n'), { start: 49152, count: 16384 })
  assert.equal(parseDynamicPorts('nothing here'), null)
})

test('socket state is recorded only for a socket-limit failure on Windows (#1810)', () => {
  const evidence = mkdtempSync(join(tmpdir(), 'agent-board-socket-state-'))
  try {
    assert.equal(recordSocketState(new Error('Timeout 30000ms exceeded.'), evidence), null)
    const record = recordSocketState(new Error('page.goto: net::ERR_NO_BUFFER_SPACE at http://127.0.0.1:1/'), evidence)
    if (process.platform !== 'win32') {
      assert.equal(record, null)
      assert.deepEqual(readdirSync(evidence), [])
      return
    }
    assert.equal(record.error, 'net::ERR_NO_BUFFER_SPACE')
    assert.ok(record.sockets && record.sockets.total > 0, JSON.stringify(record))
    assert.ok(record.dynamicPorts && record.dynamicPorts.count > 0, JSON.stringify(record))
    assert.deepEqual(readdirSync(evidence), ['socket-state.json'])
  } finally {
    rmSync(evidence, { recursive: true, force: true })
  }
})
