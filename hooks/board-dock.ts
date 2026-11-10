// The board's window docked on the right of the screen, and the place the person last gave it
// (#1084). Every size here is in the browser's own pixels (DIP, CSS px at zoom 100 %): Chromium
// reads --window-size and --window-position in them, and the page reports screenX/Y and
// outerWidth/Height in them.

export type Rect = { x: number; y: number; width: number; height: number }

// Below this work-area width the board opens as it always did: a quarter would be too narrow to read.
export const DOCK_MIN_WORK = 1280
// The dock is a quarter of the work area, kept between a comfortable reading width and its upper
// limit (PM's reading-width table on #1084, 2026-11-07).
export const DOCK_MIN_WIDTH = 400
export const DOCK_MAX_WIDTH = 560

export const dockWidth = (workWidth: number): number => Math.round(Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, workWidth * 0.25)))

// The right edge of the work area, its full height; null on a screen narrower than DOCK_MIN_WORK.
export const dockPlace = (work: Rect): Rect | null => {
  if (!(work.width >= DOCK_MIN_WORK) || !(work.height > 0)) return null
  const width = dockWidth(work.width)
  return { x: work.x + work.width - width, y: work.y, width, height: work.height }
}

const LIMIT = 100_000
const isWhole = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

// A place the page reported or the settings file holds: whole numbers, a window big enough to be
// one, on a desktop of any sane size (a monitor left of or above the primary has negative x or y).
export const isPlace = (value: unknown): value is Rect => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const { x, y, width, height } = value as Record<string, unknown>
  return isWhole(x, -LIMIT, LIMIT) && isWhole(y, -LIMIT, LIMIT) && isWhole(width, 100, LIMIT) && isWhole(height, 100, LIMIT)
}

export const placeOf = (value: unknown): Rect | null => {
  if (!isPlace(value)) return null
  const { x, y, width, height } = value
  return { x, y, width, height }
}

// The remembered place from the settings file's text; anything else means none.
export const windowPlaceOf = (text: string | null): Rect | null => {
  if (text === null || text.trim() === '') return null
  try {
    const data: unknown = JSON.parse(text)
    return data !== null && typeof data === 'object' && !Array.isArray(data) ? placeOf((data as Record<string, unknown>).window) : null
  } catch { return null }
}

const overlap = (a: Rect, b: Rect): number => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))

// The window's title bar must be on a monitor that is still there, or the person could not reach
// it to drag it back: at least a 100×30 piece of its top strip lies inside one work area.
export const isReachable = (place: Rect, works: readonly Rect[]): boolean => {
  const strip = { x: place.x, y: place.y, width: place.width, height: 30 }
  return works.some(work => overlap(strip, work) >= 100 * 30)
}

// Where the next window opens: the remembered place while its monitor is there, else the dock on
// the monitor that holds the foreground window, else nothing (the browser picks, as before).
export const launchPlace = (remembered: Rect | null, foreground: Rect | null, works: readonly Rect[]): Rect | null => {
  if (remembered !== null && isReachable(remembered, works)) return remembered
  return foreground === null ? null : dockPlace(foreground)
}

export const placeFlags = (place: Rect | null): string[] => place === null ? [] : [`--window-size=${place.width},${place.height}`, `--window-position=${place.x},${place.y}`]

// A browser profile of the board's own, so its own browser process reads the size and place: a
// shared profile hands the address to the browser already running, which drops them. A fresh Edge
// profile signs in with the Windows account and asks about sync unless sync and implicit sign-in
// are off (measured on #1084, 2026-11-10); Chrome ignores the Edge feature names.
export const profileFlags = (dir: string): string[] => [
  `--user-data-dir=${dir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-sync',
  '--disable-features=msImplicitSignin,msEdgeSyncConsent',
]

// The browser's arguments for one open of the page's address: docked (`dock=1`) or at the
// remembered place (`dock=2`) in the board's own profile; else today's plain app window (no
// profile folder, no screen read, or a screen narrower than DOCK_MIN_WORK). The page docks itself
// only for `dock=1`: a remembered place may span two monitors, and the launcher has already
// checked that its title bar is on one.
export const dockArguments = (address: string, remembered: Rect | null, probe: { foreground: Rect | null; works: readonly Rect[] } | null, profile: string | null): string[] => {
  const place = probe === null ? null : launchPlace(remembered, probe.foreground, probe.works)
  if (place === null || profile === null) return [`--app=${address}`]
  return [...profileFlags(profile), ...placeFlags(place), `--app=${address}&dock=${place === remembered ? 2 : 1}`]
}

// The screens' work areas, read by the launch PowerShell (DPI-unaware, so in the browser's own
// pixels at the system scale). The C# has no single quote, so the PowerShell string around it
// needs no escaping.
const DOCK_PROBE = `Microsoft.PowerShell.Utility\\Add-Type -Namespace AgentBoard -Name Dock -MemberDefinition '[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint f); [DllImport("user32.dll")] static extern bool GetMonitorInfoW(IntPtr m, int[] i); public delegate bool Each(IntPtr m, IntPtr dc, IntPtr r, IntPtr d); [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, Each each, IntPtr d); static string Work(IntPtr m) { int[] i = new int[10]; i[0] = 40; if (!GetMonitorInfoW(m, i)) return ""; return i[5] + "," + i[6] + "," + (i[7] - i[5]) + "," + (i[8] - i[6]); } public static string Probe() { var all = new System.Collections.Generic.List<string>(); EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (m, dc, r, d) => { string one = Work(m); if (one != "") all.Add(one); return true; }, IntPtr.Zero); return Work(MonitorFromWindow(GetForegroundWindow(), 2)) + "|" + string.Join(";", all); }'`

// The whole launch PowerShell: it prints the probe's line (`|` when the probe fails), reads the
// browser's arguments back as one base64 UTF-16 line (exit 2 when none comes), and starts the
// first of `programs` (a PowerShell list) that starts, printing its process id (exit 0); exit 1
// when none does. `isHidden` starts it hidden, for the test only.
export const dockCommand = (programs: string, workingDirectory: string, graceMs: number, isHidden = false): string =>
  `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; $PSModuleAutoLoadingPreference = 'None'; Microsoft.PowerShell.Core\\Import-Module ($PSHOME + '\\Modules\\Microsoft.PowerShell.Management\\Microsoft.PowerShell.Management.psd1'); $probe = '|'; try { Microsoft.PowerShell.Core\\Import-Module ($PSHOME + '\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1'); ${DOCK_PROBE}; $probe = [AgentBoard.Dock]::Probe() } catch {}; [Console]::Out.WriteLine($probe); [Console]::Out.Flush(); $line = [Console]::In.ReadLine(); if (-not $line) { exit 2 }; $argumentList = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($line)); foreach ($program in @(${programs})) { $started = $null; try { $started = Microsoft.PowerShell.Management\\Start-Process -FilePath $program -ArgumentList $argumentList -WorkingDirectory ${workingDirectory}${isHidden ? ' -WindowStyle Hidden' : ''} -PassThru } catch { [Console]::Error.WriteLine($_.Exception.Message); continue }; if ($started) { if ($started.WaitForExit(${graceMs}) -and $started.ExitCode -ne 0) { continue }; [Console]::Out.WriteLine($started.Id) }; exit 0 }; exit 1`

// The probe's one line: the foreground window's monitor work area, then every monitor's, each as
// x,y,width,height, e.g. `0,0,2560,1392|0,0,2560,1392;-1920,0,1920,1040`. Null when it does not read.
export const probeOf = (line: string): { foreground: Rect | null; works: Rect[] } | null => {
  const parts = line.trim().split('|')
  if (parts.length !== 2) return null
  const rect = (text: string): Rect | null => {
    const numbers = text.split(',').map(Number)
    if (numbers.length !== 4) return null
    const [x, y, width, height] = numbers as [number, number, number, number]
    return placeOf({ x, y, width, height })
  }
  const works = parts[1] === '' ? [] : parts[1]!.split(';').map(rect)
  if (works.some(one => one === null)) return null
  const foreground = parts[0] === '' ? null : rect(parts[0]!)
  if (parts[0] !== '' && foreground === null) return null
  return { foreground, works: works as Rect[] }
}

// The page's own copy of the dock, in the page's script (ES5): after load it checks that the
// window sits on the screen it opened on and docks itself when it does not (display scaling makes
// the probe and the browser disagree, a monitor can be gone). It also reports where the person
// moves or sizes the window, once that settles, so the next open goes there.
export const dockScript = String.raw`
  (function () {
    var mode = null;
    try { mode = new URLSearchParams(location.search).get('dock'); } catch (error) {}
    if ((mode !== '1' && mode !== '2') || typeof window.screen !== 'object') return;
    var MIN_WORK = ${DOCK_MIN_WORK}, MIN_WIDTH = ${DOCK_MIN_WIDTH}, MAX_WIDTH = ${DOCK_MAX_WIDTH};
    function place() { return { x: Math.round(window.screenX), y: Math.round(window.screenY), width: Math.round(window.outerWidth), height: Math.round(window.outerHeight) }; }
    function work() { var s = window.screen; return { x: s.availLeft || 0, y: s.availTop || 0, width: s.availWidth, height: s.availHeight }; }
    function dock(area) {
      if (!(area.width >= MIN_WORK) || !(area.height > 0)) return null;
      var width = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, area.width * 0.25)));
      return { x: area.x + area.width - width, y: area.y, width: width, height: area.height };
    }
    function isInside(one, area) { return one.x >= area.x - 8 && one.y >= area.y - 8 && one.x + one.width <= area.x + area.width + 8 && one.y + one.height <= area.y + area.height + 8; }
    var area = work(), now = place();
    // Only the dock is corrected: a remembered place (dock=2) is where the person put it.
    if (mode === '1' && !isInside(now, area)) {
      var target = dock(area);
      if (target) { try { window.resizeTo(target.width, target.height); window.moveTo(target.x, target.y); } catch (error) {} }
    }
    var sent = null, seen = null, timer = null;
    function same(a, b) { return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height; }
    function report() {
      timer = null;
      var one = place();
      if (same(one, sent) || one.width < 100 || one.height < 100) return;
      sent = one;
      call('/api/window', one).catch(function () {});
    }
    // No event tells a page it moved, so the place is looked at every second; a change is sent
    // once it has held for a second, not on every step of a drag. The place the window opened at
    // (and any correction above) settles first and is not sent: only the person's own move is.
    setTimeout(function () {
      sent = seen = place();
      setInterval(function () {
        var one = place();
        if (same(one, seen)) return;
        seen = one;
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(report, 1000);
      }, 1000);
    }, 1500);
  })();
`
