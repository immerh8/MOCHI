# Smoke-check the NSIS installer (plan D7, O11): silent per-user install, the files
# exist, then silent uninstall removes them. Usage: smoke-nsis.ps1 path\to\setup.exe
# Note: Windows Server runner; client-only behaviour (WebView2 bootstrap on a machine
# without it) is on the release checklist (docs/packaging.md).
param([Parameter(Mandatory = $true)][string]$Setup)
$ErrorActionPreference = "Stop"
function Fail($m) { Write-Error "SMOKE FAIL: $m"; exit 1 }

$dir = Join-Path $env:LOCALAPPDATA "MOCHI"
if (Test-Path $dir) { Fail "$dir exists before install" }
$p = Start-Process -FilePath $Setup -ArgumentList "/S" -Wait -PassThru
if ($p.ExitCode -ne 0) { Fail "installer exit code $($p.ExitCode)" }

Get-ChildItem $dir -Recurse | Select-Object -ExpandProperty FullName
$exe = Get-ChildItem $dir -Filter *.exe | Where-Object { $_.Name -notmatch "^uninstall" }
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
# Per-user: the uninstall entry is under HKCU, nothing needed elevation.
$key = Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" |
  Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -eq "MOCHI" }
if (-not $key) { Fail "no HKCU uninstall entry for MOCHI" }

# NSIS uninstallers copy themselves to %TEMP% and return at once; /S plus
# _?= keeps it in-process so -Wait works (the directory is then left empty).
$u = Start-Process -FilePath $uninst -ArgumentList "/S", "_?=$dir" -Wait -PassThru
if ($u.ExitCode -ne 0) { Fail "uninstaller exit code $($u.ExitCode)" }
if (Test-Path (Join-Path $dir $exe.Name)) { Fail "app exe still present after uninstall" }
Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
"NSIS smoke check passed"
