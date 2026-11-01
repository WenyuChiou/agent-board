// Keep the stdlib-only Python importer on the same messages as every board language.
// Run with Bun 1.4.2 after changing either remoteReport string; --check detects drift.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { STRINGS } from '../hooks/strings'

const path = fileURLToPath(new URL('./remote-reporter/strings.json', import.meta.url))
const messages = Object.fromEntries(Object.entries(STRINGS).map(([lang, s]) => [lang, {
  remoteReportFuture: s.remoteReportFuture,
  remoteReportStale: s.remoteReportStale,
}]))
const expected = `${JSON.stringify(messages, null, 2)}\n`
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== expected) throw new Error('Regenerate remote reporter strings with scripts/build-remote-strings.ts')
} else writeFileSync(path, expected)
