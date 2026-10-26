import { spawn } from 'node:child_process'

// The child exits when this process is gone, however it ends: its stdin pipe from here then closes.
const child = spawn(process.execPath, ['-e', "process.stdin.on('end', () => process.exit()).resume()"], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
// A forced kill skips this; the test that starts this fixture stops the child by its pid.
process.once('exit', () => { try { child.kill() } catch {} })
process.stdout.write(`${child.pid}\n`)
setInterval(() => {}, 1000)
