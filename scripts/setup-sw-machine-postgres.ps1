param(
  [string]$HawleyDir = "C:\Users\prode\.hawley",
  [string]$InstallBase = "C:\Hawley\PostgreSQL",
  [string]$ServiceName = "HawleyPostgres17"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$dbEnvPath = Join-Path $HawleyDir "hawley-db.env"
$installerDir = Join-Path $HawleyDir "installers"
$zipPath = Join-Path $installerDir "postgresql-17.10-2-windows-x64-binaries.zip"
$zipUrl = "https://get.enterprisedb.com/postgresql/postgresql-17.10-2-windows-x64-binaries.zip"
$extractDir = Join-Path $InstallBase "17-extract"
$dataDir = Join-Path $InstallBase "data"
$logDir = Join-Path $InstallBase "logs"

function New-HawleyPassword([int]$Length = 32) {
  $chars = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789".ToCharArray()
  $bytes = New-Object byte[] $Length
  $rng = [Security.Cryptography.RNGCryptoServiceProvider]::Create()
  $rng.GetBytes($bytes)
  -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
}

function Read-HawleyEnv([string]$Path) {
  $vars = @{}
  Get-Content -LiteralPath $Path | ForEach-Object {
    if ($_ -match "=") {
      $parts = $_ -split "=", 2
      $vars[$parts[0]] = $parts[1]
    }
  }
  $vars
}

New-Item -ItemType Directory -Force -Path $HawleyDir, $installerDir, $InstallBase, $logDir | Out-Null

if (!(Test-Path -LiteralPath $dbEnvPath)) {
  $superPass = New-HawleyPassword
  $syncPass = New-HawleyPassword
  $appPass = New-HawleyPassword
  $readPass = New-HawleyPassword
  @(
    "PGHOST=localhost"
    "PGPORT=5432"
    "PGDATABASE=bowlus_ops"
    "PGUSER=bowlus_sync"
    "PGPASSWORD=$syncPass"
    "DATABASE_URL=postgres://bowlus_sync:$syncPass@localhost:5432/bowlus_ops"
    "POSTGRES_SUPERUSER_PASSWORD=$superPass"
    "BOWLUS_APP_PASSWORD=$appPass"
    "BOWLUS_READONLY_PASSWORD=$readPass"
  ) | Set-Content -LiteralPath $dbEnvPath -Encoding UTF8
}

if (!(Test-Path -LiteralPath $zipPath)) {
  Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath
}

if (!(Test-Path -LiteralPath $extractDir)) {
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force
}

$initdb = Get-ChildItem -LiteralPath $extractDir -Filter initdb.exe -Recurse -ErrorAction Stop | Select-Object -First 1
if (!$initdb) {
  throw "initdb.exe not found after extracting Postgres binaries."
}

$binDir = Split-Path $initdb.FullName -Parent
$pgRoot = Split-Path $binDir -Parent
$pgCtl = Join-Path $binDir "pg_ctl.exe"
$psql = Join-Path $binDir "psql.exe"
$vars = Read-HawleyEnv $dbEnvPath

if (!(Test-Path -LiteralPath $dataDir)) {
  $pwFile = Join-Path $HawleyDir "pg-super-password.tmp"
  Set-Content -LiteralPath $pwFile -Value $vars["POSTGRES_SUPERUSER_PASSWORD"] -NoNewline -Encoding ASCII
  try {
    & (Join-Path $binDir "initdb.exe") -D $dataDir -U postgres -A scram-sha-256 --pwfile=$pwFile -E UTF8
  } finally {
    Remove-Item -LiteralPath $pwFile -Force -ErrorAction SilentlyContinue
  }
}

icacls $InstallBase /grant "NT AUTHORITY\NETWORK SERVICE:(OI)(CI)F" /T | Out-Null

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (!$service) {
  & $pgCtl register -N $ServiceName -D $dataDir -S auto -U "NT AUTHORITY\NetworkService"
}

$service = Get-Service -Name $ServiceName -ErrorAction Stop
if ($service.Status -ne "Running") {
  Start-Service -Name $ServiceName
  Start-Sleep -Seconds 5
}

$env:PGPASSWORD = $vars["POSTGRES_SUPERUSER_PASSWORD"]

$roleSql = @"
DO `$`$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bowlus_sync') THEN
    CREATE ROLE bowlus_sync LOGIN PASSWORD '$($vars["PGPASSWORD"])';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bowlus_app') THEN
    CREATE ROLE bowlus_app LOGIN PASSWORD '$($vars["BOWLUS_APP_PASSWORD"])';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bowlus_readonly') THEN
    CREATE ROLE bowlus_readonly LOGIN PASSWORD '$($vars["BOWLUS_READONLY_PASSWORD"])';
  END IF;
END
`$`$;
"@

& $psql -h localhost -p 5432 -U postgres -d postgres -v ON_ERROR_STOP=1 -c $roleSql | Out-Null
$dbExists = & $psql -h localhost -p 5432 -U postgres -d postgres -tAc "select 1 from pg_database where datname = 'bowlus_ops'"
if (($dbExists | Out-String).Trim() -ne "1") {
  & $psql -h localhost -p 5432 -U postgres -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE bowlus_ops OWNER bowlus_sync;" | Out-Null
}
& $psql -h localhost -p 5432 -U postgres -d postgres -v ON_ERROR_STOP=1 -c "GRANT bowlus_app TO bowlus_sync;" | Out-Null

Write-Output "---postgres-ready---"
& $psql --version
Get-Service -Name $ServiceName | Select-Object Name,Status,StartType | ConvertTo-Json -Compress
Test-NetConnection -ComputerName localhost -Port 5432 -InformationLevel Quiet
Write-Output "---paths---"
Write-Output "PGROOT=$pgRoot"
Write-Output "DATADIR=$dataDir"
Write-Output "LOGDIR=$logDir"
