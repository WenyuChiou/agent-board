// A stand-in Codex program for the Codex desktop app receiver (#557). `exec resume <id> -` reads the reply on stdin, notes in
// its log that it began, waits until its release file is there, then answers with the reply's own ACK line, as a resumed
// Codex turn does. Any other command, such as the shared daemon the board's other Codex receiver starts, exits at once with
// an error. Its config file (CODEX_EXEC_STUB) names:
//   log      file that gets one JSON line per run: its arguments and folder
//   release  a file whose appearance lets the run answer and end
//   refuse   true: the run fails at once with Codex's own writer refusal for the conversation, as while the app holds it
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

const config = JSON.parse(readFileSync(process.env.CODEX_EXEC_STUB, 'utf8'))
const args = process.argv.slice(2)
if (args[0] !== 'exec' || args[1] !== 'resume') process.exit(2)
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const prompt = Buffer.concat(chunks).toString('utf8')
appendFileSync(config.log, JSON.stringify({ args, cwd: process.cwd() }) + '\n')
const nonce = /ACK ([A-Za-z0-9]+)/.exec(prompt)?.[1]
if (config.refuse === true) {
  process.stderr.write(`Error: thread-store conflict: thread ${args[3]} already has an active writer\n`)
  process.exitCode = 1
} else {
  while (!existsSync(config.release)) await new Promise(done => setTimeout(done, 50))
  process.stdout.write(nonce ? `ACK ${nonce} Done.\n` : 'No code given.\n')
}
