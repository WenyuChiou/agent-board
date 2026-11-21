import { resolve } from 'node:path'

// Capture only explicit install locations. Environment-derived defaults belong to the running CLI,
// not to a command a person might paste into another shell.
const contextFlags = ['--home', '--data-dir', '--progress-file', '--lang', '--codex-dir', '--grok-dir', '--hermes-dir', '--opencode-dir', '--openclaw-dir', '--deepseek-dir']

export const installContext = args => ({
  flags: contextFlags.flatMap(flag => {
    const at = args.indexOf(flag)
    return at >= 0 && typeof args[at + 1] === 'string' ? [flag, args[at + 1]] : []
  }),
})

// argv contains the arguments after the program. Rendering never selects the executable used by
// setup's subprocess: that remains Node plus the owned installed script, even with an npm display prefix.
export const installCommand = (context, step, quote, render) => {
  const argv = [...context.flags]
  // A board runs from its script's folder, which wins over a --data-dir that named where setup keeps its records,
  // as for the sidecar of an Antigravity the plugin connected (#1356).
  if (step.target === 'board' && context.dataDir) {
    const at = argv.indexOf('--data-dir')
    if (at < 0) argv.splice(argv.includes('--home') ? 2 : 0, 0, '--data-dir', context.dataDir)
    else if (resolve(argv[at + 1]) !== context.dataDir) argv[at + 1] = context.dataDir
  }
  if (step.agent) argv.push('--agent', step.agent)
  if (step.mode) argv.push(step.mode)
  // Modes and consent are requested by the caller, never inherited from the original invocation.
  const allowed = step.target === 'setup' ? ['--antigravity-sidecar'] : ['--json', '--plain']
  argv.push(...new Set((step.extra ?? []).filter(arg => allowed.includes(arg))))
  if (step.apply) argv.push('--apply')
  const isRunnable = typeof step.codexBin !== 'object'
  if (step.codexBin) argv.push('--codex-bin', typeof step.codexBin === 'string' ? step.codexBin : step.codexBin.placeholder)
  const text = render ? render(context.program, argv, isRunnable) : [context.program, ...argv.map(quote)].join(' ')
  return { argv, text, isRunnable }
}
