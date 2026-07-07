param(
  [string]$ShopOpsEnvPath = "C:\Users\Ryan\Bowlus Dropbox\Production Engineering\Engineering\Jacob Working\Projects\Bowlus Shop Ops\.env",
  [int]$WorkerPort = 5273,
  [int]$LocalPostgresPort = 15432
)

$ErrorActionPreference = "Stop"

Import-Module Posh-SSH

$vars = @{}
Get-Content -LiteralPath $ShopOpsEnvPath | ForEach-Object {
  if ($_ -match "^\s*#" -or $_ -notmatch "=") {
    return
  }
  $parts = $_ -split "=", 2
  $vars[$parts[0].Trim()] = $parts[1].Trim().Trim('"')
}

$secure = ConvertTo-SecureString $vars["SW_MACHINE_SSH_PASSWORD"] -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential($vars["SW_MACHINE_SSH_USER"], $secure)
$session = New-SSHSession -ComputerName $vars["SW_MACHINE_HOST"] -Credential $cred -AcceptKey -Force -ConnectionTimeout 10

try {
  $remoteEnvCommand = @'
$envPath = "C:\Hawley\bowlus-hawley\.env"
Get-Content -LiteralPath $envPath |
  Where-Object { $_ -match "^(PGDATABASE|PGUSER|PGPASSWORD)=" }
'@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($remoteEnvCommand))
  $result = Invoke-SSHCommand -SessionId $session.SessionId -Command "powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded" -TimeOut 30
  if ($result.ExitStatus -ne 0) {
    throw "Could not read remote Hawley database env pointer."
  }

  $dbVars = @{}
  foreach ($line in $result.Output) {
    if ($line -match "^([A-Za-z_][A-Za-z0-9_]*)=(.*)$") {
      $dbVars[$matches[1]] = $matches[2].Trim().Trim('"')
    }
  }
} finally {
  Remove-SSHSession -SessionId $session.SessionId | Out-Null
}

if (-not $dbVars["PGDATABASE"] -or -not $dbVars["PGUSER"] -or -not $dbVars["PGPASSWORD"]) {
  throw "Remote Hawley database env is missing PGDATABASE, PGUSER, or PGPASSWORD."
}

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$node = "C:\Program Files\nodejs\node.exe"
$out = Join-Path $repo "runtime-output\hawley-worker-page.local.out.log"
$err = Join-Path $repo "runtime-output\hawley-worker-page.local.err.log"
New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null

Get-NetTCPConnection -LocalPort $WorkerPort -ErrorAction SilentlyContinue |
  Where-Object { $_.OwningProcess -ne 0 } |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

Start-Sleep -Seconds 1

$env:PGHOST = "127.0.0.1"
$env:PGPORT = [string]$LocalPostgresPort
$env:PGDATABASE = $dbVars["PGDATABASE"]
$env:PGUSER = $dbVars["PGUSER"]
$env:PGPASSWORD = $dbVars["PGPASSWORD"]
$env:DATABASE_URL = ""
$env:HAWLEY_WORKER_HOST = "127.0.0.1"
$env:HAWLEY_WORKER_PORT = [string]$WorkerPort

$process = Start-Process `
  -FilePath $node `
  -ArgumentList @("apps/hawley-worker-page/server.js") `
  -WorkingDirectory $repo `
  -WindowStyle Hidden `
  -RedirectStandardOutput $out `
  -RedirectStandardError $err `
  -PassThru

Start-Sleep -Seconds 2
$listener = Get-NetTCPConnection -LocalPort $WorkerPort -ErrorAction SilentlyContinue |
  Where-Object { $_.State -eq "Listen" } |
  Select-Object -First 1

[pscustomobject]@{
  processId = $process.Id
  listening = [bool]$listener
  workerUrl = "http://127.0.0.1:$WorkerPort"
  postgresTunnelPort = $LocalPostgresPort
  stdout = (Get-Content -Path $out -ErrorAction SilentlyContinue | Select-Object -Last 3) -join " | "
  stderr = (Get-Content -Path $err -ErrorAction SilentlyContinue | Select-Object -Last 3) -join " | "
} | ConvertTo-Json -Compress
