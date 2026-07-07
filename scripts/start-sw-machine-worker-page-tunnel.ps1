param(
  [string]$ShopOpsEnvPath = "C:\Users\Ryan\Bowlus Dropbox\Production Engineering\Engineering\Jacob Working\Projects\Bowlus Shop Ops\.env",
  [int]$LocalPort = 5273,
  [int]$RemotePort = 5273
)

$ErrorActionPreference = "Stop"

$scriptBlock = @'
param(
  [string]$ShopOpsEnvPath,
  [int]$LocalPort,
  [int]$RemotePort
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
  $forward = New-SSHLocalPortForward `
    -SessionId $session.SessionId `
    -BoundHost "127.0.0.1" `
    -BoundPort $LocalPort `
    -RemoteAddress "127.0.0.1" `
    -RemotePort $RemotePort
  Start-SSHPortForward -PortForward $forward | Out-Null
  while ($true) {
    Start-Sleep -Seconds 30
  }
} finally {
  Get-SSHPortForward | Where-Object { $_.BoundPort -eq $LocalPort } | Stop-SSHPortForward -ErrorAction SilentlyContinue
  Remove-SSHSession -SessionId $session.SessionId -ErrorAction SilentlyContinue | Out-Null
}
'@

$encodedScript = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($scriptBlock))
$argJson = @{
  ShopOpsEnvPath = $ShopOpsEnvPath
  LocalPort = $LocalPort
  RemotePort = $RemotePort
} | ConvertTo-Json -Compress
$argB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($argJson))

$launcher = @"
`$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$argB64')) | ConvertFrom-Json
`$script = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('$encodedScript'))
`$block = [scriptblock]::Create(`$script)
& `$block -ShopOpsEnvPath `$payload.ShopOpsEnvPath -LocalPort `$payload.LocalPort -RemotePort `$payload.RemotePort
"@

$launcherEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($launcher))
Start-Process powershell.exe `
  -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $launcherEncoded) `
  -WindowStyle Hidden

Start-Sleep -Seconds 3
$listener = Get-NetTCPConnection -LocalPort $LocalPort -ErrorAction SilentlyContinue |
  Where-Object { $_.State -eq "Listen" } |
  Select-Object -First 1

[pscustomobject]@{
  localPort = $LocalPort
  remotePort = $RemotePort
  listening = [bool]$listener
} | ConvertTo-Json -Compress
