$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = 'C:\Users\prode\Bowlus Dropbox\Production Engineering\Engineering\Jacob Working\Projects\Bowlus Shop Ops'
$backup = Join-Path $root 'data\retirement-backups\daily-tracker-2026-10-01'
New-Item -ItemType Directory -Force -Path $backup | Out-Null
$names = @('ShopOps-DailyWorkerApp','ShopOps-DashboardHost','ShopOps-DashboardWatchdog','ShopOps-DashboardKiosk','ShopOps-KioskWatchdog','PLH Dashboard Kiosk','PLH Dashboard Kiosk Direct')
foreach ($name in $names) {
  $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($t) {
    $xml = Join-Path $backup ($name+'.xml')
    if (-not (Test-Path -LiteralPath $xml)) { Export-ScheduledTask -TaskName $name | Set-Content -LiteralPath $xml -Encoding Unicode }
    Disable-ScheduledTask -TaskName $name | Out-Null
    if ($t.State -eq 'Running') { Stop-ScheduledTask -TaskName $name }
  }
}
$envPath = Join-Path $root '.env'
$envText = [IO.File]::ReadAllText($envPath)
$keys = @('TRUE_SYNC_RUN_DAILY_TRACKER','AIRSYNC_RUN_DAILY_TRACKER','DAILY_TRACKER_RETIRED')
$old = @{}
foreach ($key in $keys) { $m=[regex]::Match($envText,'(?m)^'+$key+'=([^\r\n]*)'); $old[$key]=if($m.Success){$m.Groups[1].Value}else{$null} }
$oldPath=Join-Path $backup 'previous-flags.json'
if (-not (Test-Path -LiteralPath $oldPath)) { $old | ConvertTo-Json | Set-Content -LiteralPath $oldPath }
foreach ($key in $keys) {
  $value=if($key -eq 'DAILY_TRACKER_RETIRED'){'true'}else{'false'}
  $pattern='(?m)^'+$key+'=[^\r\n]*'
  if ([regex]::IsMatch($envText,$pattern)) {$envText=[regex]::Replace($envText,$pattern,$key+'='+$value)} else {$envText+="`r`n$key=$value`r`n"}
}
[IO.File]::WriteAllText($envPath,$envText,[Text.UTF8Encoding]::new($false))
$source=Join-Path $root 'apps\airsync\DailyAssignmentSync.js'
$sourceBackup=Join-Path $backup 'DailyAssignmentSync.js'
if (-not (Test-Path -LiteralPath $sourceBackup)) { Copy-Item -LiteralPath $source -Destination $sourceBackup }
$code=[IO.File]::ReadAllText($source)
$anchor='export async function runDailyAssignmentSync(deps) {'
if (-not $code.Contains($anchor)) { throw 'Tracker entrypoint changed; refusing to patch.' }
if (-not $code.Contains('Daily Assignment Tracker retired on 2026-10-01')) {
  $guard=@'
export async function runDailyAssignmentSync(deps) {
  // Daily Assignment Tracker retired on 2026-10-01; preserve rollback through the explicit flag.
  if (process.env.DAILY_TRACKER_RETIRED === "true") {
    return { skipped: true, reason: "Daily Assignment Tracker retired; use Hawley." };
  }
'@
  [IO.File]::WriteAllText($source,$code.Replace($anchor,$guard),[Text.UTF8Encoding]::new($false))
}
& node --check $source
if ($LASTEXITCODE -ne 0) { Copy-Item -LiteralPath $sourceBackup -Destination $source -Force; throw 'Syntax check failed; source restored.' }
foreach($port in @(5173,3087)) {
  $listeners=@(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
  foreach($listener in $listeners) {
    $p=Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
    $expected=($p.Name -eq 'node.exe') -and (($port -eq 3087 -and $p.CommandLine -match 'liveRecoveryDashboardServer\.js') -or ($port -eq 5173 -and $p.CommandLine -match 'server\.js'))
    if(-not $expected){throw "Unexpected process on port $port; not stopped."}
    Stop-Process -Id $p.ProcessId -Force
    Write-Output "Stopped legacy node service on port $port (PID $($p.ProcessId))."
  }
}
Get-ScheduledTask | Where-Object {$_.TaskName -in ($names+@('ShopOps-TrueSync','ShopOps-FlaskControl'))} | Select-Object TaskName,@{n='State';e={[string]$_.State}} | ConvertTo-Json -Compress
Write-Output "Rollback files: $backup"
