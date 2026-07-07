param(
  [string]$ShopOpsEnvPath = "C:\Users\Ryan\Bowlus Dropbox\Production Engineering\Engineering\Jacob Working\Projects\Bowlus Shop Ops\.env",
  [int]$Port = 5273
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
  $remoteScript = @'
$ErrorActionPreference = "Continue"
$repo = "C:\Hawley\bowlus-hawley"
$port = __PORT__
$health = $null
$rootStatus = $null
$healthError = ""
$rootError = ""

try {
  $rootStatus = (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/" -TimeoutSec 5).StatusCode
} catch {
  $rootError = $_.Exception.Message
}

try {
  $health = (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 10).Content | ConvertFrom-Json
} catch {
  $healthError = $_.Exception.Message
}

$listener = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
  Where-Object { $_.State -eq "Listen" } |
  Select-Object -First 1

[pscustomobject]@{
  listening = [bool]$listener
  rootStatus = $rootStatus
  rootError = $rootError
  healthOk = [bool]$health.ok
  healthError = $healthError
  assignmentRows = $health.counts.assignment_rows
  workerCount = $health.counts.worker_count
  stdout = (Get-Content -Path (Join-Path $repo "runtime-output\hawley-worker-page.out.log") -ErrorAction SilentlyContinue | Select-Object -Last 5) -join " | "
  stderr = (Get-Content -Path (Join-Path $repo "runtime-output\hawley-worker-page.err.log") -ErrorAction SilentlyContinue | Select-Object -Last 20) -join " | "
} | ConvertTo-Json -Compress
'@

  $remoteScript = $remoteScript.Replace("__PORT__", [string]$Port)
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($remoteScript))
  $result = Invoke-SSHCommand -SessionId $session.SessionId -Command "powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded" -TimeOut 60
  $result.Output
  if ($result.Error) {
    $result.Error
  }
  if ($result.ExitStatus -ne 0) {
    throw "Remote worker page check failed with exit status $($result.ExitStatus)."
  }
} finally {
  Remove-SSHSession -SessionId $session.SessionId | Out-Null
}
