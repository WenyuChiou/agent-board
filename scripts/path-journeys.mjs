import { readFileSync } from 'node:fs'

// The map from source paths to the journeys and tests that cover them (scripts/path-journeys.json, #1544).
export const loadPathJourneys = () => JSON.parse(readFileSync(new URL('./path-journeys.json', import.meta.url), 'utf8')).areas

const covers = (listed, path) => listed.endsWith('/') ? path.startsWith(listed) : path === listed

// The areas, journeys and tests that cover the touched paths, each listed once, in the map's order. A test the
// change already touches is not repeated. Empty lists when no touched path is in the map.
export const journeysFor = (paths, areas = loadPathJourneys()) => {
  const touched = new Set(paths)
  const hit = areas.filter(area => paths.some(path => area.paths.some(listed => covers(listed, path))))
  const unique = pick => [...new Set(hit.flatMap(area => area[pick]))]
  return { areas: hit.map(area => area.name), journeys: unique('journeys'), tests: unique('tests').filter(path => !touched.has(path)) }
}

// One info line for preflight, or null when nothing is mapped.
export const journeyLine = (paths, areas) => {
  const found = journeysFor(paths, areas)
  if (!found.areas.length) return null
  return `touched paths are covered by (${found.areas.join(', ')}): journeys ${found.journeys.join('; ')}; tests ${found.tests.length ? found.tests.join(', ') : 'all already touched'}.`
}
