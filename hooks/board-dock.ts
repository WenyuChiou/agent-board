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

// The remembered place has a file of its own beside progress.md, not a key in the settings file:
// only the board script writes it, so no other writer's change can be lost to it and no file the
// person secured is replaced by it.
export const windowPath = (progressPath: string): string => `${progressPath.replace(/\.md$/i, '')}-window.json`

// The remembered place from the window file's text; anything else means none.
export const windowPlaceOf = (text: string | null): Rect | null => {
  if (text === null || text.trim() === '') return null
  try { return placeOf(JSON.parse(text)) } catch { return null }
}

const span = (start: number, size: number, otherStart: number, otherSize: number): number => Math.max(0, Math.min(start + size, otherStart + otherSize) - Math.max(start, otherStart))

// The window's title bar must be on a monitor that is still there, or the person could not reach
// it to drag it back: of its 30 px top strip, at least 100 px of width and 20 px of height lie
// inside one work area. Both are checked, not the area alone: a wide window with two rows of
// pixels on screen is out of reach. 20, not 30, so a maximized window, whose border sits 8 px
// outside the work area, still counts.
export const isReachable = (place: Rect, works: readonly Rect[]): boolean =>
  works.some(work => span(place.x, place.width, work.x, work.width) >= 100 && span(place.y, 30, work.y, work.height) >= 20)

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
// remembered place (`dock=2`, the place also in `at`) in the board's own profile; else today's
// plain app window (no profile folder, no screen read, or a screen narrower than DOCK_MIN_WORK).
// The address carries the place too: when the board's browser is still running (a minimized
// board), it takes the address over and drops the flags, and the new page moves itself there.
export const dockArguments = (address: string, remembered: Rect | null, probe: { foreground: Rect | null; works: readonly Rect[] } | null, profile: string | null): string[] => {
  const place = probe === null ? null : launchPlace(remembered, probe.foreground, probe.works)
  if (place === null || profile === null) return [`--app=${address}`]
  const mode = place === remembered ? `dock=2&at=${place.x},${place.y},${place.width},${place.height}` : 'dock=1'
  return [...profileFlags(profile), ...placeFlags(place), `--app=${withQuery(address, mode)}`]
}

// The options go in the address's query, before any fragment: an open for an approval ends in
// `#k=<key>` (#1368), which the page reads whole.
const withQuery = (address: string, query: string): string => {
  const hash = address.indexOf('#')
  const base = hash < 0 ? address : address.slice(0, hash)
  return `${base}${base.includes('?') ? '&' : '?'}${query}${hash < 0 ? '' : address.slice(hash)}`
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
    function isNear(a, b) { return Math.abs(a.x - b.x) <= 8 && Math.abs(a.y - b.y) <= 8 && Math.abs(a.width - b.width) <= 8 && Math.abs(a.height - b.height) <= 8; }
    function asked() {
      var parts = null;
      try { parts = (new URLSearchParams(location.search).get('at') || '').split(','); } catch (error) { return null; }
      if (parts.length !== 4) return null;
      for (var i = 0; i < 4; i++) if (!/^-?\d+$/.test(parts[i])) return null;
      var one = { x: +parts[0], y: +parts[1], width: +parts[2], height: +parts[3] };
      return one.width >= 100 && one.height >= 100 ? one : null;
    }
    // A board's browser still running (a minimized board) takes a new open over and drops the size
    // and place flags, so a newly opened page goes to the place it was opened for itself: the dock
    // (dock=1) or the remembered place in 'at' (dock=2). A reload is not a new open: a window the
    // person moved since stays. The dock is also corrected whenever it is off its screen; a
    // remembered place is not, as it may span two monitors.
    var isNew = true;
    try { var entry = performance.getEntriesByType('navigation')[0]; if (entry && entry.type !== 'navigate') isNew = false; } catch (error) {}
    var area = work(), now = place();
    var target = mode === '1' ? dock(area) : asked();
    if (target && ((isNew && !isNear(now, target)) || (mode === '1' && !isInside(now, area)))) {
      try { window.resizeTo(target.width, target.height); window.moveTo(target.x, target.y); } catch (error) {}
    }
    var sent = null, seen = null, timer = null, isSending = false, wait = 1000, sendNumber = 0;
    function same(a, b) { return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height; }
    // A page a newer one replaced, or one the person closed, (isClosed, the page's own flag) is no
    // longer the board's window: its moves are not the place to open at. A place counts as sent
    // only once the computer kept it; one it did not keep (the window file held for a moment) is
    // sent again while the window stays there, each wait twice the last, up to a minute.
    function report() {
      timer = null;
      if (isClosed) return;
      var one = place();
      if (same(one, sent) || one.width < 100 || one.height < 100) return;
      // One report at a time, so an older place cannot land after a newer one.
      if (isSending) { timer = setTimeout(report, 1000); return; }
      isSending = true;
      var mine = ++sendNumber;
      function settle(isKept) {
        if (mine !== sendNumber || !isSending) return;
        isSending = false;
        if (isKept) { sent = one; wait = 1000; } else wait = Math.min(wait * 2, 60000);
      }
      // A report the server never answers counts as not kept after 10 s, so it cannot stop the
      // reports after it; its late answer is ignored.
      setTimeout(function () { if (mine === sendNumber && isSending) { sendNumber++; isSending = false; wait = Math.min(wait * 2, 60000); } }, 10000);
      call('/api/window', one).then(function (data) { return data && data.ok; }, function () { return false; }).then(settle);
    }
    // No event tells a page it moved, so the place is looked at every second; a change is sent
    // once it has held for a second, not on every step of a drag. The place the window opened at
    // (and any correction above) settles first and is not sent: only the person's own move is.
    setTimeout(function () {
      sent = seen = place();
      setInterval(function () {
        if (isClosed) return;
        var one = place();
        if (!same(one, seen)) {
          seen = one;
          wait = 1000;
          if (timer !== null) clearTimeout(timer);
          timer = setTimeout(report, 1000);
        } else if (timer === null && !isSending && !same(one, sent)) timer = setTimeout(report, wait);
      }, 1000);
    }, 1500);
  })();
`
