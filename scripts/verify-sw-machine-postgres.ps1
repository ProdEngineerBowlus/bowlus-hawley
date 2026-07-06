param(
  [string]$ShopOpsEnvPath = "C:\Users\Ryan\Bowlus Dropbox\Production Engineering\Engineering\Jacob Working\Projects\Bowlus Shop Ops\.env"
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
$ErrorActionPreference = "Stop"
$repoPath = "C:\Hawley\bowlus-hawley"
$git = "C:\Program Files\Git\cmd\git.exe"
$psql = "C:\Hawley\PostgreSQL\17-extract\pgsql\bin\psql.exe"
$dbEnv = "C:\Users\prode\.hawley\hawley-db.env"

$vars = @{}
Get-Content -LiteralPath $dbEnv | ForEach-Object {
  if ($_ -match "=") {
    $parts = $_ -split "=", 2
    $vars[$parts[0]] = $parts[1]
  }
}

$env:PGPASSWORD = $vars["PGPASSWORD"]

Write-Output "---service---"
Get-Service -Name "HawleyPostgres17" | Select-Object Name,Status,StartType | ConvertTo-Json -Compress
Write-Output "PORT_5432=$((Test-NetConnection -ComputerName localhost -Port 5432 -InformationLevel Quiet))"

Write-Output "---repo---"
Push-Location $repoPath
& $git log --oneline -1
& $git status --short --branch
Pop-Location

Write-Output "---database---"
& $psql -h localhost -p 5432 -U $vars["PGUSER"] -d $vars["PGDATABASE"] -tAc "select string_agg(schema_name, ', ' order by schema_name) from information_schema.schemata where schema_name in ('raw','core','calc','reporting','sync');"
& $psql -h localhost -p 5432 -U $vars["PGUSER"] -d $vars["PGDATABASE"] -tAc "select string_agg(filename, ', ' order by filename) from sync.schema_migrations;"
& $psql -h localhost -p 5432 -U $vars["PGUSER"] -d $vars["PGDATABASE"] -tAc "select count(*) from information_schema.views where table_schema = 'reporting' and table_name = 'daily_worker_assignments';"
'@

  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($remoteScript))
  $result = Invoke-SSHCommand -SessionId $session.SessionId -Command "powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded" -TimeOut 120
  $result.Output
  if ($result.Error) {
    $result.Error
  }
} finally {
  Remove-SSHSession -SessionId $session.SessionId | Out-Null
}
