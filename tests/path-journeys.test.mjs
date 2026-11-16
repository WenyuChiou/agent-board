import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { journeyLine, journeysFor, loadPathJourneys } from '../scripts/path-journeys.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

test('the path-to-journeys map names only files and journeys that exist (#1544)', () => {
  const areas = loadPathJourneys()
  assert.ok(areas.length >= 4)
  for (const area of areas) {
    for (const test of area.tests) assert.ok(existsSync(root + test), `${area.name}: ${test}`)
    for (const path of area.paths) assert.ok(path.endsWith('/') ? existsSync(root + path) : existsSync(root + path), `${area.name}: ${path}`)
    for (const journey of area.journeys) {
      const [file, name] = journey.split(': ')
      assert.ok(existsSync(root + file), `${area.name}: ${file}`)
      assert.ok(name && fileText(file).includes(name), `${area.name}: no "${name}" in ${file}`)
    }
  }
})

const fileText = file => readFileSync(root + file, 'utf8')

test('journeysFor lists the journeys and tests of the touched paths, once each, and prints an info line only when mapped (#1544)', () => {
  const found = journeysFor(['hooks/receivers/opencode.ts', 'hooks/messaging.ts', 'docs/GUIDE.md'])
  assert.deepEqual(found.areas, ['delivery'])
  assert.ok(found.journeys.some(item => item.includes('L3b messages between sessions and agents')))
  assert.ok(found.tests.includes('tests/messaging.test.mjs'))
  assert.equal(new Set(found.tests).size, found.tests.length)
  // A test the change already touches is not repeated; two areas both show.
  const two = journeysFor(['scripts/setup.sh', 'hooks/retention.ts', 'tests/setup-remove.test.mjs'])
  assert.deepEqual(two.areas, ['setup-writes', 'data'])
  assert.ok(!two.tests.includes('tests/setup-remove.test.mjs') && two.tests.includes('tests/retention.test.ts'))
  // A path outside the map, a near-miss name and a test file give nothing.
  for (const paths of [['docs/GUIDE.md'], ['hooks/messaging.tsx'], ['tests/messaging.test.mjs'], []]) {
    assert.deepEqual(journeysFor(paths), { areas: [], journeys: [], tests: [] }, paths.join())
    assert.equal(journeyLine(paths), null)
  }
  assert.match(journeyLine(['scripts/setup.sh']), /^touched paths are covered by \(setup-writes\): journeys tests\/journeys\.test\.tsx: L1 first run; tests /)
})
