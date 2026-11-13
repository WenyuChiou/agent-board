import { expect, test } from './kit'
import { agentHooks, withGroupedHook } from '../hooks/connect'

test('reconnecting Codex preserves each owned group position and foreign hook groups', () => {
  const context = {home:'/synthetic',sep:'/',isWindows:false,script:'/synthetic/progress-report.sh',inbox:'/synthetic/progress-inbox',codexHome:'/synthetic/.codex',grokHome:'/synthetic/.grok',hermesHome:'/synthetic/.hermes',openclawHome:'/synthetic/.openclaw'}
  const hook = agentHooks(context).find(one => one.agent === 'codex' && one.label !== '')!
  const initial = JSON.parse(hook.edit('{}',false) as string)
  for (const event of ['Stop','SessionEnd','UserPromptSubmit']) {
    const own = initial.hooks[event][0]
    initial.hooks[event] = [{hooks:[{type:'command',command:'foreign-before'}]},own,{hooks:[{type:'command',command:'foreign-after'}]}]
  }
  const text = JSON.stringify(initial, null, 2) + '\n'
  const after = hook.edit(text,false)
  expect(after).toBe(text)
  expect(hook.edit(after as string,false)).toBe(text)
})

test('grouped hook renewal retains foreign entries inside a mixed group at their original positions', () => {
  const before = {custom:true,hooks:{Stop:[{matcher:'*',hooks:[{type:'command',command:'before'},{type:'command',command:'sh /synthetic/progress-report.sh codex turn'},{type:'command',command:'after'}]},{hooks:[{type:'command',command:'last'}]}]}}
  const after = withGroupedHook(before,'Stop','sh /synthetic/progress-report.sh codex turn',{timeout:10})
  expect(after).toEqual({custom:true,hooks:{Stop:[{matcher:'*',hooks:[{type:'command',command:'before'},{type:'command',command:'sh /synthetic/progress-report.sh codex turn',timeout:10},{type:'command',command:'after'}]},{hooks:[{type:'command',command:'last'}]}]}})
})
