# Smoke-check the NSIS installer (plan D7, D6, O11): silent per-user install, the files
# and the shell registration exist, then silent uninstall removes them all, twice: once
# with the default (the foreign-format opt-in is OFF) and once with /ASSOCIATE_FOREIGN.
# Usage: smoke-nsis.ps1 path\to\setup.exe
# Note: Windows Server runner; client-only behaviour (WebView2 bootstrap on a machine
# without it, Explorer's menu display) is on the release checklist (docs/packaging.md).
param([Parameter(Mandatory = $true)][string]$Setup)
$ErrorActionPreference = "Stop"
function Fail($m) { Write-Error "SMOKE FAIL: $m"; exit 1 }

$dir = Join-Path $env:LOCALAPPDATA "MOCHI"
$classes = [Microsoft.Win32.Registry]::CurrentUser

# The default value of HKCU\Software\Classes\<sub>, or $null if the key is absent.
# (The registry API, not the HKCU: drive, because the key "*" is a wildcard there.)
function Get-ClassDefault($sub) {
  $k = $classes.OpenSubKey("Software\Classes\$sub")
  if (-not $k) { return $null }
  try { return [string]$k.GetValue("") } finally { $k.Close() }
}
function Test-ClassKey($sub) {
  $k = $classes.OpenSubKey("Software\Classes\$sub")
  if ($k) { $k.Close(); return $true }
  return $false
}
function Test-OpenWith($ext) {
  $k = $classes.OpenSubKey("Software\Classes\.$ext\OpenWithProgids")
  if (-not $k) { return $false }
  try { return ($k.GetValueNames() -contains "MOCHI.Foreign") } finally { $k.Close() }
}

# Every key and value this installer may add (plan D6; packaging/nsis/hooks.nsh).
# One cascading submenu "MOCHI" per class, with its entries as subkeys; the flat verbs of
# 0.1.0 must be gone as well (an update removes them, an uninstall leaves none).
$verbKeys = @(
  "SystemFileAssociations\.mochi\shell\MochiMenu",
  "*\shell\MochiMenu",
  "Directory\shell\MochiMenu",
  "SystemFileAssociations\.mochi\shell\MochiOpen",
  "SystemFileAssociations\.mochi\shell\MochiExtractHere",
  "SystemFileAssociations\.mochi\shell\MochiExtractToFolder",
  "*\shell\MochiAdd",
  "Directory\shell\MochiAdd"
)
$foreignExts = "zip", "7z", "rar", "tar", "tgz", "gz"

$installKey = "HKCU:\Software\The MOCHI Project contributors\MOCHI"

function Assert-NothingRegistered($when) {
  foreach ($k in $verbKeys + @("MOCHI.Archive", "MOCHI.Foreign")) {
    if (Test-ClassKey $k) { Fail "$when : HKCU\Software\Classes\$k exists" }
  }
  if (Test-ClassKey ".mochi") { Fail "$when : HKCU\Software\Classes\.mochi exists" }
  foreach ($e in $foreignExts) {
    if (Test-OpenWith $e) { Fail "$when : MOCHI.Foreign still offered for .$e" }
  }
  # Tauri's install-location key; packaging/nsis/hooks.nsh removes it on uninstall.
  if (Test-Path $installKey) { Fail "$when : $installKey exists" }
}

function Run-Cycle([string[]]$SetupArgs, [bool]$ExpectForeign) {
  Assert-NothingRegistered "before install"
  if (Test-Path $dir) { Fail "$dir exists before install" }
  $p = Start-Process -FilePath $Setup -ArgumentList $SetupArgs -Wait -PassThru
  if ($p.ExitCode -ne 0) { Fail "installer exit code $($p.ExitCode)" }

  Get-ChildItem $dir -Recurse | Select-Object -ExpandProperty FullName
  $exe = Get-ChildItem $dir -Filter *.exe | Where-Object { $_.Name -notmatch "^uninstall" -and $_.Name -ne "mochi-foreign-helper.exe" }
  if ($exe.Count -ne 1) { Fail "expected one app exe in $dir, found $($exe.Count)" }
  if ($exe.Length -lt 1MB) { Fail "$($exe.Name) is suspiciously small" }
  $uninst = Join-Path $dir "uninstall.exe"
  if (-not (Test-Path $uninst)) { Fail "no uninstall.exe (per-user install must be removable)" }
  $lic = Join-Path $dir "licenses\THIRD-PARTY-LICENSES.txt"
  if (-not (Test-Path $lic)) { Fail "third-party license list missing" }
  $text = Get-Content $lic -Raw
  foreach ($s in "Rust crates:", "npm packages (UI bundle):", "MIT License") {
    if (-not $text.Contains($s)) { Fail "license list lacks '$s'" }
  }
  foreach ($s in "UnRAR source code may be used in any software") {
    if (-not $text.Contains($s)) { Fail "license list lacks the RARLAB UnRAR notice" }
  }
  foreach ($c in "unrar_sys", "sevenz-rust2", "zip", "tar", "flate2") {
    if ($text -notmatch "Used by:[^\r\n]*(^|[ ,])$([regex]::Escape($c)) \d") { Fail "license list does not cover the helper's dependency $c" }
  }
  # F8: the user guide sits at the resource path the app resolves (help.rs GUIDE_RESOURCE,
  # "guide/index.html" under the install directory), with every page, offline and static.
  $guideIndex = Join-Path $dir "guide\index.html"
  if (-not (Test-Path $guideIndex)) { Fail "user guide missing at $guideIndex" }
  foreach ($page in "index", "not-a-backup", "getting-started", "encrypted", "verification", "tar-compatible", "recovery-record", "experimental") {
    $f = Join-Path $dir "guide\$page.html"
    if (-not (Test-Path $f) -or (Get-Item $f).Length -eq 0) { Fail "user guide page $page.html missing or empty" }
  }
  $guideText = Get-Content $guideIndex -Raw
  if (-not $guideText.Contains("This guide is written for the mochi command line.")) { Fail "user guide lacks its command-line scope banner" }
  if ($guideText -match "<script|src=|https?://") { Fail "user guide must be offline and static" }
  # D8 (T16): the foreign-format helper sits next to the app (where the app looks for it),
  # runs, and answers a protocol-v2 list of a real fixture.
  $helper = Join-Path $dir "mochi-foreign-helper.exe"
  if (-not (Test-Path $helper)) { Fail "mochi-foreign-helper.exe not installed next to the app" }
  if ((Get-Item $helper).Length -lt 500KB) { Fail "mochi-foreign-helper.exe is suspiciously small" }
  $fixture = Join-Path $PSScriptRoot "..\fixtures\foreign\basic_infozip.zip"
  $probe = Join-Path $PSScriptRoot "helper_probe.py"
  & python -I $probe $helper (Resolve-Path $fixture).Path --expect a.txt --expect sub/b.txt
  if ($LASTEXITCODE -ne 0) { Fail "the installed helper did not list the fixture" }
  # Tauri writes its install-location key (read again by the next install).
  if (-not (Test-Path $installKey)) { Fail "no $installKey after install" }
  # Per-user: the uninstall entry is under HKCU, nothing needed elevation.
  $key = Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" |
    Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -eq "MOCHI" }
  if (-not $key) { Fail "no HKCU uninstall entry for MOCHI" }

  # D6: the .mochi association, the Explorer verbs, and the opt-in.
  $exePath = $exe.FullName
  if ((Get-ClassDefault ".mochi") -ne "MOCHI.Archive") { Fail ".mochi is not associated with MOCHI.Archive" }
  $open = Get-ClassDefault "MOCHI.Archive\shell\open\command"
  if (-not $open -or -not $open.Contains($exePath)) { Fail "MOCHI.Archive open command does not run the installed app: $open" }
  # The submenu: a menu key (text "MOCHI", empty SubCommands) whose own shell key holds the entries.
  $addItems = [ordered]@{ "40Add" = @("--add-now", "Add to archive"); "50AddPanel" = @("--add", "Add to archive...") }
  $mochiItems = [ordered]@{
    "10Open"            = @("--open", "Open with MOCHI");
    "20ExtractHere"     = @("--extract-here", "Extract here");
    "30ExtractToFolder" = @("--extract-to-folder", "Extract to a new folder")
  }
  foreach ($n in $addItems.Keys) { $mochiItems[$n] = $addItems[$n] }
  $menus = [ordered]@{
    "SystemFileAssociations\.mochi" = $mochiItems;
    "*"                              = $addItems;
    "Directory"                      = $addItems
  }
  foreach ($class in $menus.Keys) {
    $menu = "$class\shell\MochiMenu"
    $mk = $classes.OpenSubKey("Software\Classes\$menu")
    if (-not $mk) { Fail "submenu $menu is not registered" }
    try {
      if ($mk.GetValue("MUIVerb") -ne "MOCHI") { Fail "submenu $menu has the wrong text: '$($mk.GetValue('MUIVerb'))'" }
      if ($null -eq $mk.GetValue("SubCommands")) { Fail "submenu $menu has no SubCommands value (the cascade would not show)" }
    } finally { $mk.Close() }
    $items = $menus[$class]
    foreach ($item in $items.Keys) {
      $k = "$menu\shell\$item"
      $text = Get-ClassDefault $k
      if ($text -ne $items[$item][1]) { Fail "menu entry $k has text '$text', expected '$($items[$item][1])'" }
      $cmd = Get-ClassDefault "$k\command"
      if (-not $cmd) { Fail "menu entry $k has no command" }
      $expect = "`"$exePath`" $($items[$item][0]) -- `"%1`""
      if ($cmd -ne $expect) { Fail "menu entry $k runs '$cmd', expected '$expect'" }
      if ($cmd -match "passphrase|password") { Fail "menu entry $k puts a secret option on the command line" }
    }
    # Nothing else under the submenu.
    $sk = $classes.OpenSubKey("Software\Classes\$menu\shell")
    try {
      $names = @($sk.GetSubKeyNames())
      if ($names.Count -ne $items.Count) { Fail "submenu $menu has entries [$($names -join ', ')], expected [$($items.Keys -join ', ')]" }
    } finally { $sk.Close() }
  }
  # The flat verbs of 0.1.0 are not registered next to the submenu.
  foreach ($old in $verbKeys | Where-Object { $_ -notlike "*MochiMenu" }) {
    if (Test-ClassKey $old) { Fail "legacy verb $old is still registered" }
  }
  # The opt-in is OFF unless asked for, and never writes a type's default value.
  foreach ($e in $foreignExts) {
    if ((Test-OpenWith $e) -ne $ExpectForeign) { Fail ".$e offered = $(Test-OpenWith $e), expected $ExpectForeign" }
    $d = Get-ClassDefault ".$e"
    if ($d -and $d -eq "MOCHI.Foreign") { Fail ".$e default was taken over by MOCHI" }
  }
  if ($ExpectForeign) {
    $fc = Get-ClassDefault "MOCHI.Foreign\shell\open\command"
    if ($fc -ne "`"$exePath`" --open -- `"%1`"") { Fail "MOCHI.Foreign command is '$fc'" }
  } elseif (Test-ClassKey "MOCHI.Foreign") { Fail "MOCHI.Foreign exists though the opt-in was not asked for" }

  # NSIS uninstallers copy themselves to %TEMP% and return at once; /S plus
  # _?= keeps it in-process so -Wait works (the directory is then left empty).
  $u = Start-Process -FilePath $uninst -ArgumentList "/S", "_?=$dir" -Wait -PassThru
  if ($u.ExitCode -ne 0) { Fail "uninstaller exit code $($u.ExitCode)" }
  if (Test-Path (Join-Path $dir $exe.Name)) { Fail "app exe still present after uninstall" }
  if (Test-Path $helper) { Fail "mochi-foreign-helper.exe still present after uninstall" }
  if (Test-Path $guideIndex) { Fail "user guide still present after uninstall" }
  Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
  # Uninstall removes every key and association it added (plan D6).
  Assert-NothingRegistered "after uninstall"
}

# A silent install takes the default: the foreign-format opt-in is off.
Run-Cycle @("/S") $false
# The explicit switch turns it on; uninstall still removes all of it.
Run-Cycle @("/S", "/ASSOCIATE_FOREIGN") $true
"NSIS smoke check passed"
