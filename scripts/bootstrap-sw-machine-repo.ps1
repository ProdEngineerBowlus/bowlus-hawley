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
$repoParent = "C:\Users\prode\Bowlus Dropbox\Production Engineering\Engineering\Jacob Working\Projects"
$repoPath = Join-Path $repoParent "bowlus-hawley"
$git = "C:\Program Files\Git\cmd\git.exe"
$npm = "C:\Program Files\nodejs\npm.cmd"

function Invoke-Native {
  param(
    [string]$FilePath,
    [string[]]$Arguments
  )
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath failed with exit code $LASTEXITCODE"
  }
}

New-Item -ItemType Directory -Force -Path $repoParent | Out-Null

if (Test-Path -LiteralPath $repoPath) {
  $validRepo = $false
  if (Test-Path -LiteralPath (Join-Path $repoPath ".git")) {
    Push-Location $repoPath
    & $git rev-parse --is-inside-work-tree | Out-Null
    $validRepo = $LASTEXITCODE -eq 0
    Pop-Location
  }

  if (!$validRepo) {
    if ((Split-Path -Leaf $repoPath) -ne "bowlus-hawley") {
      throw "Refusing to remove unexpected repo path: $repoPath"
    }
    Remove-Item -LiteralPath $repoPath -Recurse -Force
  }
}

if (!(Test-Path -LiteralPath $repoPath)) {
  Invoke-Native $git @("clone", "https://github.com/jacobrhodes20-dev/jacobrhodes20-dev-bowlus-hawley.git", $repoPath)
} else {
  Push-Location $repoPath
  Invoke-Native $git @("fetch", "origin")
  Invoke-Native $git @("checkout", "main")
  Invoke-Native $git @("pull", "--ff-only", "origin", "main")
  Pop-Location
}

Copy-Item -LiteralPath "C:\Users\prode\.hawley\hawley-db.env" -Destination (Join-Path $repoPath ".env") -Force

Push-Location $repoPath
Invoke-Native $npm @("install")
Invoke-Native $npm @("run", "pg:health")
Invoke-Native $npm @("run", "pg:migrate")
Invoke-Native $git @("status", "--short", "--branch")
Pop-Location
'@

  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($remoteScript))
  $result = Invoke-SSHCommand -SessionId $session.SessionId -Command "powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded" -TimeOut 900
  $result.Output
  if ($result.Error) {
    $result.Error
  }
} finally {
  Remove-SSHSession -SessionId $session.SessionId | Out-Null
}
