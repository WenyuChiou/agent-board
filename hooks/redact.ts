// The patterns that mask a credential or the home folder in a line of words, kept apart from the board's views so a hook
// script can mask a line without loading them (#1798). `hooks/board.ts` re-exports `redact`.
const MASK = '•••'

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Every way the home folder is written: both slashes, the doubled backslashes that JSON and
// Python error messages print, and on Windows the form Git Bash gives (/c/Users/me). A folder
// name may hold spaces.
export const homeForms = (home: string): string[] => {
  const folder = home.replace(/[\\/]+$/, '')
  if (folder === '') return []
  const slashed = folder.replace(/\\/g, '/')
  const drive = /^([A-Za-z]):\//.exec(slashed)
  const forms = new Set([folder, slashed, slashed.replace(/\//g, '\\'), slashed.replace(/\//g, '\\\\'), ...(drive === null ? [] : [`/${drive[1]}${slashed.slice(2)}`])])

  return [...forms].sort((a, b) => b.length - a.length)
}

// Another account's folder, or this one written as this computer does not report it (WSL's
// /mnt/c/Users/me). A name here may hold spaces ("Jane Doe"), up to three words: where it ends
// is the slash after it, and more words than that is a sentence, not a name. A path in a link
// (`https://site/home/x`) is not one: a word comes before its slash.
const NAME_WORD = '[^\\\\/\\s:*?"<>|`\'()]+'
const OTHER_HOMES = new RegExp(`(?<![\\w.-])(?:[A-Za-z]:[\\\\/]Users|\\/mnt\\/[A-Za-z]\\/Users|\\/Users|\\/home)[\\\\/]${NAME_WORD}(?: ${NAME_WORD}){0,2}(?=[\\\\/])`, 'gi')

// A secret's name, then its value: quoted (it may hold spaces) or up to the next space. A quote
// that is never closed hides the rest of the line: where the value ends is not known. The name
// before the keyword is kept short, so a long unbroken word is not tried from every letter.
const VALUE = `"[^"\\n]*(?:"|$)|'[^'\\n]*(?:'|$)|\\S+`
const ASSIGNED = new RegExp(`([\\w-]{0,40}(?:key|secret|token|pass(?:word|wd)?|pwd|credentials?)["']?[ \\t]*[:=][ \\t]*)(${VALUE})`, 'gim')
const FLAG = new RegExp(`(--(?:password|token|secret|api-key)[= ])(?:${VALUE})`, 'gim')
const BEARER = /\b(Bearer)\s+\S+/gi
// "Basic" is also a plain word ("Basic setup"): what follows must look like an encoded
// value, four letters or more with a capital, a digit, + / or = after its first letter.
const BASIC = /\b([Bb]asic)\s+(?=\S[A-Za-z0-9+/_-]*[A-Z0-9+/=])[A-Za-z0-9+/_-]{4,}={0,2}/g
const PREFIXED = /(?<![A-Za-z0-9])(?:(?:sk-|sk_(?:live|test)_|rk_|xox[abprs]-|glpat-|AIza|hf_|npm_|gh[pousr]_|github_pat_)[\w-]+|A(?:KIA|SIA)[0-9A-Z]{16}|eyJ[\w-]+\.[\w-]+\.[\w-]+)/g
// A user may be empty (`redis://:secret@host`) and a password may hold an @ or a / (an access
// key does): it runs to the last @ before a space, and the host follows. That also hides the @
// of a link's own query (`http://host:3000/a?mail=a@b.com`): the safe side. `ssh://git@host`,
// `https://a@b.com` and `mailto:` have no password.
const USER_PASS = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#@:]*:\S*@/gi
// The board's own address carries its key as ?t=; other links carry theirs under these names.
const KEYED = 't|token|access_token|id_token|auth|key|api_key|apikey|secret|sig|signature'
const KEYED_LATER = new RegExp(`&(?:${KEYED})=[^&\\s#]*`, 'gi')
const KEYED_FIRST_MORE = new RegExp(`\\?(?:${KEYED})=[^&\\s#]*&`, 'gi')
const KEYED_FIRST = new RegExp(`\\?(?:${KEYED})=[^&\\s#]*`, 'gi')

// `home` is the person's home folder (`os.homedir()`); on Windows a folder's letters may be
// written in any case.
export const redact = (text: string, home: string, isWindows = false): string => {
  const forms = homeForms(home)
  const own = forms.length === 0 ? null : new RegExp(`(?<![\\w.-])(?:${forms.map(escapeRegExp).join('|')})(?![\\w-]|\\.\\w)`, isWindows ? 'gi' : 'g')

  return (own === null ? text : text.replace(own, '~'))
    .replace(OTHER_HOMES, '~')
    .replace(USER_PASS, `$1${MASK}@`)
    .replace(KEYED_LATER, '')
    .replace(KEYED_FIRST_MORE, '?')
    .replace(KEYED_FIRST, '')
    .replace(FLAG, `$1${MASK}`)
    .replace(BEARER, `$1 ${MASK}`)
    .replace(BASIC, `$1 ${MASK}`)
    .replace(ASSIGNED, (assignment, head: string, value: string, at: number, whole: string) => {
      // A bare key/token label can describe a quota or other ordinary work ("key: 100",
      // "token: budget"). Only a number of up to five digits or one plain word stays, and only
      // when the label stands alone ("api.key:", "$key:" are names). A one-time code, a value
      // mixing letters and digits ("hunter2"), a code in capitals, an assignment, a quoted
      // value or a long token is masked.
      const isDescription = /^(?:key|token)[ \t]*:[ \t]*$/i.test(head) && (at === 0 || /\s/.test(whole[at - 1] ?? '')) && /^(?:\d{1,5}|[A-Za-z][a-z]{0,18})$/.test(value)
      return isDescription ? assignment : `${head}${MASK}`
    })
    .replace(PREFIXED, MASK)
}

// A command an agent asks to run, as one line of words for a card (#1798). The line is made first (control characters, bidi marks and
// every kind of white space become one space) and masked after, so a secret split by a tab or two spaces is still one `--flag value`.
// `redact` runs, then the forms below that a command line has and a sentence does not. A list of forms never names every secret: the
// page on the local network never gets this line, and the board script keeps no more of it than the first 2,000 characters.
export const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u034f\ufe00-\ufe0f\u{E0000}-\u{E007F}]+/gu
const PASS_FLAG = new RegExp(`(--(?:[\\w-]*-)?(?:password|passwd|pwd|pass|token|secret|api-?key|access-?key|private-?key|auth|credentials?|key)(?:[= ]+))(?:${VALUE})`, 'gi')
// curl -u user:pass, --user user:pass, and a proxy's. The short -u also takes its
// argument attached (-uuser:pass); a long flag never does, so only -u may skip the separator.
const USER_FLAG = /((?:^|\s)(?:-u|--user|--proxy-user)(?:[= ]+|(?<=-u)))(?:"[^"]*:[^"]*"|'[^']*:[^']*'|[^\s:]*:\S*)/gi
// sshpass -p X, and an attached -pX with a digit or a capital in it, or six letters or more
// (mysql takes a bare -p as a prompt; -print, -perm and -pi do not match). A quoted span
// after -p is one argument, so the whole span is the value, spaces inside it included.
const SSHPASS = new RegExp(`(\\bsshpass\\s+(?:-\\S+\\s+)*-p\\s*)(?:${VALUE})`, 'gi')
const SHORT_P = /(?<=\s)(-p)("[^"\n]*(?:"|$)|'[^'\n]*(?:'|$)|[^\s=-]\S*)/g

export const approvalWords = (text: string, home: string, isWindows: boolean, max: number): string => {
  const line = text.replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim().slice(0, 20000)

  // The cut to `max` comes last, so a secret is never half cut into a shape the patterns no longer know.
  return redact(line, home, isWindows)
    .replace(PASS_FLAG, `$1${MASK}`)
    .replace(USER_FLAG, `$1${MASK}`)
    .replace(SSHPASS, `$1${MASK}`)
    .replace(SHORT_P, (whole, flag: string, value: string) => /[A-Z0-9]/.test(value) || value.length >= 6 ? `${flag}${MASK}` : whole)
    .slice(0, max)
}
