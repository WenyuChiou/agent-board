// The commands the pane's hourly sweep runs to make the archives folder and move an old month into
// it (#922). Windows PowerShell 5.1's New-Item has no -LiteralPath, so the folder comes from .NET,
// which reads the path as written (brackets too) and does nothing when the folder is already there.
// No run-time imports, so a plain-Node test runs these exact commands on each system.
const psQuote = (text: string): string => `'${text.replace(/'/g, "''")}'`

export const makeFolderCommand = (isWin: boolean, folder: string): string[] => isWin
  ? ['powershell', '-NoProfile', '-Command', `[void][System.IO.Directory]::CreateDirectory(${psQuote(folder)})`]
  : ['mkdir', '-p', folder]

// `mv -n` and Move-Item without -Force both leave a name that appeared meanwhile alone.
export const moveFileCommand = (isWin: boolean, from: string, to: string): string[] => isWin
  ? ['powershell', '-NoProfile', '-Command', `Move-Item -LiteralPath ${psQuote(from)} -Destination ${psQuote(to)} -ErrorAction Stop`]
  : ['mv', '-n', from, to]
