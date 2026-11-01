const HEAP_VALUES = new Set([
  '--max-semi-space-size', '--min-semi-space-size', '--max-old-space-size',
  '--max-old-space-size-percentage', '--max-heap-size', '--initial-heap-size',
  '--initial-old-space-size', '--heap-growing-percent',
])
const HEAP_SWITCHES = new Set(['--optimize-for-size', '--no-optimize-for-size', '--nooptimize-for-size'])
const ARGUMENT_VALUES = new Set(['--require', '-r', '--import', '--loader', '--experimental-loader', '--eval', '-e'])
const inheritedHeap = /(?:^|[\s"'])--(?:(?:no-)?optimize-for-size|(?:max|min)-semi-space-size|max-old-space-size(?:-percentage)?|max-heap-size|initial-(?:heap-size|old-space-size)|heap-growing-percent)(?=[=\s"']|$)/

// A page outlives its launcher. Favor bounded allocation slack, without limiting the board's
// live data or propagating this policy through NODE_OPTIONS to programs the page starts.
export const serverMemoryArgs = (execArgv: readonly string[], nodeOptions = ''): string[] => {
  const chosen: string[] = []
  for (let index = 0; index < execArgv.length; index++) {
    const argument = execArgv[index]
    if (argument === undefined) continue
    const name = argument.split('=')[0]?.replaceAll('_', '-') ?? ''
    if (ARGUMENT_VALUES.has(name)) {
      if (!argument.includes('=')) index++
      continue
    }
    if (!HEAP_VALUES.has(name) && !HEAP_SWITCHES.has(name)) continue
    chosen.push(argument)
    const value = execArgv[index + 1]
    if (HEAP_VALUES.has(name) && !argument.includes('=') && value !== undefined && !value.startsWith('--')) {
      chosen.push(value)
      index++
    }
  }
  return chosen.length > 0 || inheritedHeap.test(nodeOptions.replaceAll('_', '-')) ? chosen : ['--optimize-for-size']
}

// glibc gives each thread that allocates its own malloc arena and keeps freed pages in it, so on
// Linux a page grew about 50 MB outside the JS heap in a 30-minute soak; two arenas kept it flat
// (#266). The account's own setting wins. The page drops the setting once it has started, so the
// programs it starts get the account's environment.
const ARENA_MARK = 'AGENT_BOARD_MALLOC_ARENA'
export const serverMemoryEnv = (env: NodeJS.ProcessEnv, platform: string = process.platform): NodeJS.ProcessEnv =>
  platform === 'linux' && env.MALLOC_ARENA_MAX === undefined ? { ...env, MALLOC_ARENA_MAX: '2', [ARENA_MARK]: '1' } : env
export const dropServerMemoryEnv = (env: NodeJS.ProcessEnv): void => {
  if (env[ARENA_MARK] !== '1') return
  delete env.MALLOC_ARENA_MAX
  delete env[ARENA_MARK]
}
