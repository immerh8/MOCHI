# Run phase: control experiments, then the real workload. The host marks the
# dm-log-writes log at every Mark call below.
. C:\g6\payload\common.ps1
try {
  Say 'RUN-START'
  $d = Get-G6Disk 'G6D000'
  if (-not $d) { throw 'data disk not found' }
  Online-G6Disk $d
  Start-Sleep 3
  Update-Disk -Number $d.Number -ErrorAction SilentlyContinue
  $part = Get-Partition -DiskNumber $d.Number | Where-Object { $_.Type -eq 'Basic' } | Select-Object -First 1
  if (-not $part) { throw 'no data partition' }
  if (-not $part.DriveLetter) {
    Set-Partition -DiskNumber $d.Number -PartitionNumber $part.PartitionNumber -NewDriveLetter E
    $letter = 'E'
  } else { $letter = [string]$part.DriveLetter }
  $root = "${letter}:\"
  if (-not (Test-Path $root)) { throw "$root is not mounted" }
  try { Add-MpPreference -ExclusionPath $root } catch { }
  Say ('VOLUME ' + (Get-Volume -DriveLetter $letter | Select-Object FileSystemType, Size | ConvertTo-Json -Compress))
  Start-Sleep 5

  Mark 'run:begin'

  # Controls (as in G7): data followed by FlushFileBuffers must be in the log
  # before the acknowledgement; data that was never flushed must be droppable.
  New-Item -ItemType Directory -Force "${root}ctl" | Out-Null
  foreach ($k in 1..3) {
    $b = New-Object byte[] 262144
    for ($i = 0; $i -lt $b.Length; $i++) { $b[$i] = (($i * 7) + $k) -band 255 }
    $sha = Sha256Bytes $b
    $fs = [System.IO.File]::Open("${root}ctl\synced_$k.bin", 'Create', 'Write', 'None')
    $fs.Write($b, 0, $b.Length); $fs.Flush($true); $fs.Close()
    Mark "ctl:synced:${k}:${sha}:$($b.Length)"
    $fs = [System.IO.File]::Open("${root}ctl\unsynced_$k.bin", 'Create', 'Write', 'None')
    $fs.Write($b, 0, $b.Length); $fs.Close()
    Mark "ctl:unsynced:${k}:${sha}:$($b.Length)"
  }

  Mark 'workload:begin'
  & C:\g6\payload\g6_winworkload.exe workload $root '\\.\COM1' *> C:\g6\wl.out
  $rc = $LASTEXITCODE
  Mark 'workload:end'
  Say "WORKLOAD-RC $rc"
  Get-Content C:\g6\wl.out -ErrorAction SilentlyContinue | ForEach-Object { Say "WL $_" }
  Say 'RUN-DONE'
} catch { Say ('RUN-ERROR ' + $_.Exception.Message) }
