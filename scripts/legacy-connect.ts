import { reporterPs1, reporterSh, agentHooks, boardLangOf, boardScriptFor, connectDataRoots, connectPath, COLLISION, DELETE, generatedFile, hasOurHook, isNodeSupported, isReleased, isReleasedBoard, NODE_MIN, OPENCLAW_MIN, openclawSavedBy, openclawTooOld, setupAgents, setupLines, setupProblemText, worseHook } from '../hooks/connect-pure'
import type { AgentSetup, HookState, SetupNotice, SetupProblem, SetupState } from '../hooks/connect-pure'
import { langOf, STRINGS } from '../hooks/strings'
import type { ConnectTransaction, LegacyConnectRequest } from './connect-transaction'
import type { CodexTrustObservation } from './codex-host'
import { codexApproval } from './codex-approval'
import { codexFallbackCommand, managedFallback } from '../hooks/codex-fallback'
import { sha256 } from '../hooks/sha256'

const skillFolder = (file: string): string | null => /[\\/]SKILL\.md$/.test(file) ? file.replace(/[\\/][^\\/]*$/, '') : null

export const connectLegacy = (transaction: ConnectTransaction, request: LegacyConnectRequest, bundle: string, isWin: boolean, observation?: CodexTrustObservation): { text: string; lines: string[]; done: string[]; problems: SetupProblem[] } => {
  const mode = request.mode
  const remove = mode === 'remove'
  const isAuto = mode === 'auto'
  const s = STRINGS[request.lang]
  const readLocal = (file: string): string => transaction.read(file)
  const readMaybe = (file: string): string | null => transaction.maybe(file)
  const path = request.progress
  const home = request.home
  const existsSync = (file: string): boolean => transaction.exists(file)
  const sep = isWin ? '\\' : '/'
  const codexHome = request.dirs?.codex ?? [home, '.codex'].join(sep)
  const codexSource = [codexHome, 'hooks.json'].join(sep)
  const codexBefore = readMaybe(codexSource)
  const beforeHash = codexBefore === null ? null : sha256(codexBefore)
  const grokHome = request.dirs?.grok ?? [home, '.grok'].join(sep)
  const hermesHome = request.dirs?.hermes ?? [home, '.hermes'].join(sep)
  const openclawHome = request.dirs?.openclaw ?? [home, '.openclaw'].join(sep)
  const opencodeHome = request.dirs?.opencode ?? [home, '.config', 'opencode'].join(sep)
  const folder = path.replace(/[\\/][^\\/]*$/, '')
  const script = folder + sep + 'progress-report.' + (isWin ? 'ps1' : 'sh')
  const board = folder + sep + 'agent-board.mjs'
  const reporter = isWin ? reporterPs1() : reporterSh(folder + sep + 'progress-inbox')
  const fileLang = transaction.state.boardLang ?? langOf(boardLangOf(readMaybe(board) ?? '')) ?? request.lang
  const boardCode = boardScriptFor(path, fileLang, bundle)
  const inboxPath = (_: string): string => folder + sep + 'progress-inbox'
  const boardScript = (path: string, lang: string): string => boardScriptFor(path, lang, bundle)
  const done: string[] = []
  let hasMovedData = false
  // What needs the person, each under a key of its own (its kind and path), so a session start
  // tells of it once, whatever the language.
  const problems: SetupProblem[] = []
  const warn = (key: string, notice: SetupNotice): void => {
    if (!problems.some(one => one.key === key)) problems.push({ key, ...notice })
  }
  // How the hook of each agent found here came out, and which board files are in place.
  const hookStates = new Map<string, Omit<AgentSetup, 'board'>>()
  const boardFiles: Partial<Record<string, 'ok' | 'failed'>> = {}
  const mark = (hook: { agent: string; label: string }, state: HookState): void => {
    if (remove) return
    if (hook.label === '') {
      if (boardFiles[hook.agent] !== 'failed') boardFiles[hook.agent] = state === 'configured' ? 'ok' : 'failed'
      return
    }
    const was = hookStates.get(hook.label)
    hookStates.set(hook.label, { agent: hook.agent, label: hook.label, hook: was?.hook === undefined || was.hook === null ? state : worseHook(was.hook, state) })
  }
  const failedLabels = new Set<string>()
  let canRemoveBoard = true
  const previousOutput = (file: string): string | undefined => transaction.previous(file)
  const removeFile = (file: string): void => transaction.change(file, null)
  const writeFile = (file: string, content: string, generated = false): void => transaction.change(file, content, generated)
  const preserve = (file: string): void => warn(`preserved:${file}`, { message: 'connectPreserved', args: [file] })
  const sharedFile = (file: string, content: string, legacy: readonly string[] | ((text: string) => boolean) = [], failed: 'connectBoardFailed' | 'connectReporterFailed' = 'connectBoardFailed'): boolean => {
    let isReading = true
    try {
      const exists = existsSync(file)
      const before = readLocal(file)
      isReading = false
      const after = generatedFile(content, legacy)(before, remove, previousOutput(file))
      if ((exists && before === '') || after === COLLISION) {
        preserve(file)
        return false
      }
      if (after === DELETE) removeFile(file)
      else if (typeof after === 'string') {
        if (after !== before) writeFile(file, after, true)
        else transaction.own(file, after)
      }
      return true
    } catch (error) {
      if (error instanceof Error && error.message === 'RECOVERY_CONFLICT') throw error
      if (isReading) warn(`unreadable:${file}`, { message: 'connectBoardReadFailed', args: [file] })
      else if (remove) warn(`removeFailed:${file}`, { message: 'connectRemoveFailed', args: [file] })
      else warn(`writeFailed:${file}`, { message: failed, args: [file] })
      return false
    }
  }
  // A foreign script must never become the command installed in another agent's hook.
  // The reporter is retained on removal for queued/in-flight hooks; only owned board
  // scripts with no remaining command files are removed below.
  // A file a release wrote before the plugin kept a record of its output is ours too, by its
  // exact bytes (hooks/released.ts), so an upgrade from any of them goes through silently.
  const hasReporter = remove || (sharedFile(script, reporter, text => isReleased(isWin ? 'reporterPs1' : 'reporterSh', text, { inbox: inboxPath(path) }), 'connectReporterFailed'))
  // This bundle in another language is ours too, as is any released one. Ownership still
  // compares the whole file: an edited bundle, old or new, is preserved.
  const knownBoards = (text: string): boolean => Object.values(STRINGS).some(words => text === boardScript(path, words.lang)) || isReleasedBoard(text, path)
  const hasBoard = remove || (sharedFile(board, boardCode, knownBoards))
  const savedBy = remove ? null : openclawSavedBy(readMaybe([openclawHome, 'openclaw.json'].join(sep)) ?? '')
  // A config no OpenClaw has saved yet (installed, never run) says nothing of its version,
  // so OpenClaw is asked, as it is when the config names one too old.
  const hasOpenclaw = !remove && (existsSync(openclawHome))
  const openclawOld =
    !hasOpenclaw || (savedBy !== null && openclawTooOld(savedBy) === null) ? null : openclawTooOld(request.openclawVersion ?? savedBy ?? '')
  // Agents with a hook file that could not be written. OpenClaw's config entry loads its
  // plugin file, so when the plugin file fails, the entry is not written either.
  const failed = new Set<string>()
  // A skill is a folder of ours; an agent may complain of one left without its SKILL.md. Only
  // an empty folder goes, so anything the person added stays. One that stays empty is named, the
  // board script still goes (nothing runs it), and the next remove looks at the folder again.
  const tidyFolder = (folder: string | null, label: string): void => {
    if (folder === null || (transaction.tidy(folder))) return
    warn(`removeFailed:${folder}`, { message: 'connectRemoveFailed', args: [folder] })
    failedLabels.add(label)
  }
  for (const hook of agentHooks({ home, sep, isWindows: isWin, script, inbox: inboxPath(path), codexHome, grokHome, hermesHome, openclawHome, opencodeHome, board, s: STRINGS[fileLang] })) {
    let isInstalled = false
    for (const dir of hook.dirs ?? [hook.dir]) isInstalled = isInstalled || (existsSync(dir))
    // Taking the hooks out goes by our own files, so one an earlier connect left where the
    // agent is not (or is no longer) found comes out too, and so does a skill folder an earlier
    // remove could not take away.
    const skillDir = skillFolder(hook.file)
    if (remove) for (const file of [hook.file, ...(hook.old === undefined ? [] : [hook.old]), ...(skillDir === null ? [] : [skillDir])]) isInstalled = isInstalled || (existsSync(file))
    if (!isInstalled) continue
    // Found, but its reporter or the board script is not ours to run: the problem with that
    // file is named above, and the agent is named as not set up.
    if (!remove && hook.label !== '' && (failed.has(hook.agent) || !hasReporter)) {
      mark(hook, 'failed')
      continue
    }
    if (!remove && hook.label === '' && (failed.has(hook.agent) || !hasBoard)) {
      if (!hasBoard) mark(hook, 'failed')
      continue
    }
    // One agent whose file cannot be written (a folder missing, a read-only file) is named and
    // passed over, so the agents after it are still hooked in.
    let activeFile = hook.file
    let isReading = true
    try {
      // Left under the plugin's earlier name, it would report every turn a second time.
      const hadOld = hook.old !== undefined && (existsSync(hook.old))
      if (hadOld && hook.old !== undefined) {
        activeFile = hook.old
        const old = readLocal(hook.old)
        isReading = false
        if (hook.edit(old, true, previousOutput(hook.old)) !== DELETE) {
          preserve(hook.old)
          failedLabels.add(hook.label)
          if (!remove) { failed.add(hook.agent); mark(hook, 'failed'); continue }
        } else removeFile(hook.old)
      }
      activeFile = hook.file
      isReading = true
      const exists = existsSync(hook.file)
      const before = readMaybe(hook.file)
      isReading = false
      if (before === null) {
        if (remove) {
          warn(`removeFailed:${hook.file}`, { message: 'connectRemoveFailed', args: [hook.file] })
          failedLabels.add(hook.label)
          if (hook.label === '') canRemoveBoard = false
        } else {
          // A session start says so too, once: an agent left out without a word looks set up.
          // Its status line points below, where the read failure is named.
          mark(hook, 'failed')
          warn(`unreadable:${hook.file}`, hook.label === '' ? { message: 'connectBoardReadFailed', args: [hook.file] } : { message: 'connectReadFailed', args: [hook.label, hook.file] })
        }
        continue
      }
      let previous = previousOutput(hook.file)
      const otherRoots = connectDataRoots(before, true).filter(root => connectPath(root, isWin) !== connectPath(folder, isWin))
      if (!remove && otherRoots.length > 0) {
        // Only exact generated templates from the old path qualify for takeover;
        // an edited skill or plugin still follows the ordinary preservation rule.
        if (hook.generated && previous === undefined) for (const root of otherRoots) for (const words of Object.values(STRINGS)) {
          const oldHook = agentHooks({
            home, sep, isWindows: isWin,
            script: root + sep + 'progress-report.' + (isWin ? 'ps1' : 'sh'),
            inbox: root + sep + 'progress-inbox', board: root + sep + 'agent-board.mjs',
            codexHome, grokHome, hermesHome, openclawHome, opencodeHome, s: words,
          }).find(one => one.file === hook.file)
          if (oldHook?.edit(before, true) === DELETE) previous = before
        }
      }
      const after = hook.edit(before, remove || (hook.agent === 'openclaw' && openclawOld !== null), previous)
      if ((hook.generated && exists && before === '') || after === COLLISION) {
        preserve(hook.file)
        mark(hook, 'failed')
        failedLabels.add(hook.label)
        if (hook.label === '') canRemoveBoard = false
        if (!remove && hook.label !== '') failed.add(hook.agent)
        continue
      }
      // An OpenClaw too old for our entry would not start with it in its config, so it is not
      // hooked in, and what an earlier connect put there comes back out.
      if (hook.agent === 'openclaw' && openclawOld !== null) {
        if (after === DELETE) removeFile(hook.file)
        else if (typeof after === 'string' && after !== before) writeFile(hook.file, after, hook.generated)
        mark(hook, 'tooOld')
        warn('tooOld:openclaw', { message: 'connectTooOld', args: [hook.label, openclawOld, OPENCLAW_MIN] })
        continue
      }
      if (remove && before.trim() === '') {
        if (hadOld) done.push(hook.label)
        if (!exists) tidyFolder(skillDir, hook.label)
        continue
      }
      if (after === null) {
        if (remove && before.trim() !== '') {
          warn(`removeFailed:${hook.file}`, { message: 'connectRemoveFailed', args: [hook.file] })
          failedLabels.add(hook.label)
        } else if (!remove && hook.label !== '') {
          mark(hook, 'unreadable')
          warn(`unreadable:${hook.file}`, { message: 'connectSkipped', args: [hook.label, hook.file] })
        }
        continue
      }
      if (after === DELETE) {
        removeFile(hook.file)
        tidyFolder(skillDir, hook.label)
      } else if (after !== before) {
        writeFile(hook.file, after, hook.generated)
      } else if (!remove && hook.generated) {
        transaction.own(hook.file, after)
      }
      const hasMovedHook = !remove && typeof after === 'string' && after !== before
        && (hook.generated || /progress-report\.(?:ps1|sh)/.test(before))
        && otherRoots.some(root =>
          !connectDataRoots(after, true).some(one => connectPath(one, isWin) === connectPath(root, isWin)),
        )
      if (hasMovedHook) hasMovedData = true
      mark(hook, 'configured')
      if ((remove || isAuto) && after === before && !hadOld) continue
      // A session that only brings our own hook up to date (a new timeout, say) does not
      // announce the agent as newly connected.
      // Taking our hooks out also drops empty lists, so whether that changes the text says
      // nothing; the reporter's name in the file does.
      // Codex and Hermes ask the person to approve a changed hook again, so those still say so.
      // A file of ours from an earlier version, by its record, is not news either.
      if (isAuto && !hasMovedHook && hook.agent !== 'codex' && hook.agent !== 'hermes' && (hook.edit(before, true, previous) === DELETE || hasOurHook(before))) continue
      // OpenClaw takes two files, a plugin and the config entry that loads it.
      if (hook.label === '' || done.includes(hook.label)) continue
      done.push(hook.label)
      // The old instructions section is only tidied away; the hook is in either way.
      if (!remove && hook.agent !== 'codex') transaction.dropSection(hook.agent, home, codexHome, opencodeHome, sep)
    } catch (error) {
      if (error instanceof Error && error.message === 'RECOVERY_CONFLICT') throw error
      // A board command (no label of its own) that fails leaves the agent's hook
      // as it is: the board is an extra, the hook is what reports.
      if (hook.label !== '') failed.add(hook.agent)
      mark(hook, 'failed')
      failedLabels.add(hook.label)
      if (hook.label === '') canRemoveBoard = false
      if (isReading) warn(`unreadable:${activeFile}`, hook.label === '' ? { message: 'connectBoardReadFailed', args: [activeFile] } : { message: 'connectReadFailed', args: [hook.label, activeFile] })
      else if (remove) warn(`removeFailed:${activeFile}`, { message: 'connectRemoveFailed', args: [activeFile] })
      else warn(`writeFailed:${activeFile}`, hook.label === '' ? { message: 'connectBoardFailed', args: [activeFile] } : { message: 'connectFailed', args: [hook.label, activeFile] })
    }
  }
  const codexCurrent = readMaybe(codexSource)
  const decision = codexApproval(observation, codexSource, codexCurrent === null ? null : sha256(codexCurrent), transaction.state.codexApproval, transaction.state.setup?.codexTrusted, beforeHash)
  let codexTrusted = decision.trusted
  if (remove || decision.approval === undefined) delete transaction.state.codexApproval
  else transaction.state.codexApproval = decision.approval
  if (existsSync(codexHome)) {
    const instructions = [[codexHome, 'AGENTS.md'].join(sep), [codexHome, 'AGENTS.override.md'].join(sep)]
    const effective = existsSync(instructions[1]!) && readMaybe(instructions[1]!)?.trim() !== '' ? instructions[1]! : instructions[0]!
    if (!remove && !codexTrusted) warn('codex:approval', { message: 'setupCodexApproval', args: [] })
    for (const file of instructions) {
      try {
        const before = readLocal(file)
        // Instruction reads can yield to an external editor. Recheck source and
        // owned executables at each retirement, not only when the lock was taken.
        if (codexTrusted && decision.approval?.sourceHash !== sha256(readLocal(codexSource))) {
          codexTrusted = false
          warn('codex:approval', { message: 'setupCodexApproval', args: [] })
        }
        const ownsBoard = !remove && transaction.previous(board) !== undefined
        const canRetireFallback = codexTrusted && hasReporter && hasBoard && ownsBoard && transaction.previous(script) !== undefined
        const canRestore = !remove && !canRetireFallback && file === effective && ownsBoard
        const after = managedFallback(before, remove || canRetireFallback ? null : canRestore ? s.codexFallbackInstructions(codexFallbackCommand(board, path)) : '')
        if (after === null) { preserve(file); continue }
        // An empty content sentinel retains existing text without creating instructions
        // when the board is foreign or this is the overridden file.
        if (after !== before && (remove || canRetireFallback || canRestore)) writeFile(file, after)
      } catch (error) {
        if (error instanceof Error && error.message === 'RECOVERY_CONFLICT') throw error
        warn(`fallback:${file}`, { message: remove ? 'connectRemoveFailed' : 'connectBoardFailed', args: [file] })
      }
    }
  }
  if (remove) {
    if (canRemoveBoard) sharedFile(board, boardCode, knownBoards)
    else if (existsSync(board)) warn(`boardRetained:${board}`, { message: 'connectBoardRetained', args: [board] })
  }
  // A written hook says nothing of the board: its commands run Node.js, which a native Codex
  // install, say, does not bring.
  const hasBoardCommand = !remove && Object.values(boardFiles).includes('ok')
  const node = hasBoardCommand ? request.node : null
  const isNodeReady = node !== null && isNodeSupported(node)
  if (hasBoardCommand && node === null) warn('node:missing', { message: 'setupNodeMissing', args: [NODE_MIN] })
  else if (hasBoardCommand && node !== null && !isNodeReady) warn(`node:old:${node}`, { message: 'setupNodeOld', args: [node, NODE_MIN] })
  const state: SetupState = { agents: setupAgents([...hookStates.values()], boardFiles, isNodeReady), problems, node, codexTrusted }
  if (request.mode === 'connect') transaction.state.connectedProgress = path
  // Kept for `/progress connect status`; taking the hooks out leaves nothing to show, unless
  // the removal could not finish, whose problems stay to be shown.
  if (remove) {
    transaction.state.notified = []
    if (problems.length === 0) delete transaction.state.setup
    else transaction.state.setup = { agents: [], problems, node: null }
  } else transaction.state.setup = state
  const completed = done.filter(label => !failedLabels.has(label))
  const trust = [...(completed.includes('Codex') && !codexTrusted ? [s.connectCodexTrust] : []), ...(completed.includes('Hermes Agent') ? [s.connectHermesTrust] : [])]
  // An agent found but left out is named below it, so "none found" would contradict that.
  const none = problems.length === 0 ? [s.connectNone] : []
  const lines = remove
    ? [...(problems.length > 0 ? [s.connectRemoveIncomplete] : []), ...(completed.length > 0 ? [s.connectRemoved(completed.join(s.listSep))] : problems.length === 0 ? [s.connectNothingRemoved] : [])]
    : isAuto
      ? [...(completed.length > 0 ? [s.autoConnected(completed.join(s.listSep))] : []), ...trust, ...(hasBoard ? [s.boardEverywhere(board)] : []), s.autoConnectUndo]
      : completed.length === 0
        ? [...none, ...(hasBoard ? [s.boardEverywhere(board)] : [])]
        : [s.connectDone(completed.join(s.listSep)), ...(hasBoard ? [s.boardEverywhere(board)] : [])]
  if (hasMovedData && completed.length > 0) {
    if (isAuto) lines.splice(lines.length - 1, 0, s.connectRepairedData)
    else lines.push(s.connectMovedData)
  }

  // Connecting by hand also shows where each agent stands, with the problems below it.
  const status = mode === 'connect' && state.agents.length > 0 ? setupLines(state, s) : problems.map(one => setupProblemText(one, s))

  return { text: [...lines, ...status].join('\n'), lines, done: completed, problems }
}
