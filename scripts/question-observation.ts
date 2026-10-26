import { observeQuestions } from '../hooks/questions'

type Inputs = Parameters<typeof observeQuestions>

// The file reader owns immutable parsed projects and ledgers. Reuse only an observation that
// created no identity: now and incarnation affect new identities and must stay fresh for those.
export const reusableQuestionObservation = (): typeof observeQuestions => {
  let previous: {
    ledger: Inputs[0]
    projects: Inputs[1]
    mine: Inputs[2]
    isSettled: boolean
    proofs: Inputs[7]
    sources: string
    result: ReturnType<typeof observeQuestions>
  } | null = null
  return (...input: Inputs) => {
    const [ledger, projects, mine, , , isSettled = false, , proofs] = input
    // These lists can be rebuilt or edited without a new container. Compare every field,
    // including source times and producer evidence, before reusing an observation.
    const sources = JSON.stringify([input[3], proofs, input[8] ?? [], input[9] ?? [], [...(input[10] ?? [])]])
    if (previous?.ledger === ledger && previous.projects === projects && previous.mine === mine
      && previous.isSettled === isSettled && previous.proofs === proofs && previous.sources === sources) return previous.result
    const result = observeQuestions(...input)
    previous = result.ledger.next === ledger.next ? { ledger, projects, mine, isSettled, proofs, sources, result } : null
    return result
  }
}
