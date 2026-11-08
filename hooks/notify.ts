import { keepRecent } from './remind'

// The board server's own system notification: the page shows a browser
// notification while a tab is open; the server sends one so it works with the
// browser closed (#1014). One notification per new waiting question across
// both surfaces, never one per tab. No new dependency.

export type NotifyAsk = {
  key: string
  notifyKey?: string
  isOwn?: boolean
  agent: string
  project: string
  text: string
}

const keyOf = (ask: NotifyAsk): string => ask.notifyKey ?? ask.key

// The questions the server should tell the person about now: waiting, not the
// person's own, and not already told.
export const serverNotifyDue = (
  asks: readonly NotifyAsk[],
  told: Readonly<Record<string, number>>,
): NotifyAsk[] => asks.filter(ask => !ask.isOwn && told[keyOf(ask)] === undefined)

// Mark asks told, pruning the way the plugin's told store does. The live keys
// are the questions waiting now, so a waiting question is not told again
// because many others were told since.
export const markServerTold = (
  asks: readonly NotifyAsk[],
  told: Readonly<Record<string, number>>,
  now: number,
): Record<string, number> => {
  const next = { ...told }
  for (const ask of asks) {
    if (ask.isOwn) continue
    next[keyOf(ask)] = now
  }
  return keepRecent(next, now, new Set(asks.map(keyOf)))
}

// One check, both directions: when a page that opted in is open, the page
// handles the question, so the server only marks it told; otherwise the
// server tells the person about the questions it has not told yet.
export const serverNotifyCheck = (
  asks: readonly NotifyAsk[],
  told: Readonly<Record<string, number>>,
  now: number,
  pagePresent: boolean,
): { due: NotifyAsk[]; told: Record<string, number> } => {
  if (pagePresent) return { due: [], told: markServerTold(asks, told, now) }
  const due = serverNotifyDue(asks, told)
  return { due, told: markServerTold(due, told, now) }
}

// The system command that shows a notification, per platform. No new
// dependency: PowerShell's built-in toast on Windows, osascript on macOS,
// notify-send on Linux. Null when the platform has none.
export const serverNotifyCommand = (
  platform: string,
  title: string,
  body: string,
): { command: string; args: string[] } | null => {
  if (platform === 'win32') return { command: 'powershell', args: ['-NoProfile', '-Command', windowsToastScript(title, body)] }
  if (platform === 'darwin') return { command: 'osascript', args: ['-e', `display notification ${applescriptString(body)} with title ${applescriptString(title)}`] }
  if (platform === 'linux') return { command: 'notify-send', args: [title, body] }
  return null
}

// A PowerShell string in single quotes: a quote is doubled, nothing else is special.
const powershellString = (value: string): string => `'${value.replaceAll(`'`, `''`)}'`

// A Windows toast through the built-in WinRT API, no module. The notifier id is
// the product name; a toast from an unregistered id still shows.
// GetElementsByTagName returns a live list: indexing it with [n] enumerates it,
// and appending a child modifies the document, so the second index fails with
// "Collection was modified". Hold both nodes through .Item() first, then append.
const windowsToastScript = (title: string, body: string): string => [
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
  '$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
  '$textNodes = $template.GetElementsByTagName(\'text\')',
  '$titleNode = $textNodes.Item(0)',
  '$bodyNode = $textNodes.Item(1)',
  `$titleNode.AppendChild($template.CreateTextNode(${powershellString(title)})) | Out-Null`,
  `$bodyNode.AppendChild($template.CreateTextNode(${powershellString(body)})) | Out-Null`,
  '$toast = [Windows.UI.Notifications.ToastNotification]::new($template)',
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(\'Agent Board\').Show($toast)',
].join('\n')

// An AppleScript string in double quotes: a backslash and a quote are escaped.
const applescriptString = (value: string): string => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
