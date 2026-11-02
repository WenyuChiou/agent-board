// All names, paths, ids and logs here are synthetic. No clock or platform input is read.
export const bigBoardNow = Date.parse('2026-10-25T12:00:00Z')
export const bigBoardFirstObserved = bigBoardNow - 10 * 24 * 60 * 60 * 1000

const agents = ['claude', 'codex', 'cursor', 'gemini', 'muse', 'grok', 'hermes', 'opencode']

export const bigBoard = (seed = 460) => {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('seed must be an unsigned 32-bit integer')
  let state = seed
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state
  }
  const hex = () => random().toString(16).padStart(8, '0')
  const lines = ['# Synthetic big board', '']
  for (let project = 0; project < 50; project++) {
    // Worktree-shaped folders belong to five synthetic repositories.
    const folder = `fixture-repo-${project % 5}-${Math.floor(project / 5) + 1}`
    lines.push(`## ${folder}`, '')
    for (let card = 0; card < 6; card++) {
      const index = project * 6 + card
      const session = hex()
      const agent = agents[index % agents.length]
      const isStopped = index < 200
      const updated = new Date(bigBoardNow - (isStopped ? 4 * 24 * 60 * 60 * 1000 : 60 * 1000)).toISOString()
      const dir = index % 3 === 0 ? `C:\\synthetic\\${folder}` : `${index % 3 === 1 ? '/Users/synthetic' : '/home/synthetic'}/${folder}`
      const resume = `${session}-${hex().slice(0, 4)}-4000-8000-${hex()}${hex().slice(0, 4)}`
      const role = card % 2 === 0 ? 'Main session' : 'Helper run'
      lines.push(`<!-- auto session=${session} agent=${agent} state=${isStopped ? 'ended' : 'working'} updated=${updated} resume=${resume} dir=${encodeURIComponent(dir)} -->`)
      lines.push(`### ${role} ${index + 1}: ${index % 2 === 0 ? '核對合成資料' : 'Compare synthetic totals'}`)
      lines.push(`- [~] ${index % 2 === 0 ? '檢查測試結果' : 'Check fixture results'} ${random() % 1000}`)
      const questions = index < 200 ? 2 : 1
      for (let question = 0; question < questions; question++) {
        let text = `${index % 2 === 0 ? '要保留哪一份合成報告？' : 'Which synthetic report should we keep?'} Card ${index + 1}, ask ${question + 1}`
        if (question === 0 && index < 2) text = 'Should the repeated synthetic comparison use plan A?'
        lines.push(`- [?] ${text}`)
      }
      // Deliberately tempting diagnostics: renderers, rather than this fixture, decide what to show.
      if (index % 73 === 0) lines.push(`- [ ] Synthetic log ${'合成 output '.repeat(230)}${hex()}${hex()}${hex()}${hex()}${hex()}`)
      if (index === 200) lines.push(`- [ ] ${JSON.stringify({ event: 'synthetic-turn', session: resume, path: dir, result: { commit: hex(), ok: true } })}`)
      lines.push(`<!-- /auto session=${session} -->`, '')
    }
  }
  return `${lines.join('\n')}\n`
}
