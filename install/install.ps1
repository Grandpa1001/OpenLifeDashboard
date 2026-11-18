# OpenLifeDashboard installer, local mode on Windows (Architektura §12.4, §15.1; DEV §9.58).
#
#   install.ps1 [-Mode local] [-Dir <folder>] [-Port <host port>] -Image <image>
#               [-OwnerEmail <e-mail>] [-OwnerPasswordStdin] [-Yes]
#
# The same installer as install.sh, for Windows PowerShell 5.1 and PowerShell 7 with Docker Desktop
# running Linux containers. Stages, each recorded in control/install-state.json when it is done:
#   preparing -> files -> images -> started -> owner -> complete
# This release of the script (D59.1) does the stage 'files' and stops with the status 3: the
# containers (images, started, owner, complete) come with D59.2, so it never claims that the
# installation is complete. It never overwrites: every file is written only when it does not exist,
# through a temporary file and a rename, so an interrupted run leaves a folder that the next run
# continues. Secrets are generated once, with the first .env. Nothing is written before every check
# of the preflight has passed. The owner's password is never a parameter, a variable of the
# environment or a file.
#
# Exit status: 0 done, 1 an error, 2 wrong use, 3 the files are ready and the installation is not.
[CmdletBinding()]
param(
  [string]$Mode = 'local',
  [string]$Dir = '',
  [string]$Port = '',
  [string]$Image = '',
  [string]$OwnerEmail = '',
  [switch]$OwnerPasswordStdin,
  [switch]$Yes,
  [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$StateFormatVersion = 1
$MinDockerMajor = 25            # start_interval of the healthcheck (docker/compose.yml)
$MinComposeMajor = 2
$MinComposeMinor = 24
$MinFreeBytes = 1GB             # for the image, the database and its copies
$MinPort = 1024
$MaxPort = 65535
$DefaultPort = 8080
$ExitWaiting = 3
$MaxFolderChars = 200           # the paths below the folder stay under the 260 characters of a Windows path
$OwnerEmailMaxLength = 254
$RequiredPlatform = 'Win32NT'   # [Environment]::OSVersion.Platform of a Windows computer
$DockerUserId = 1000            # Docker Desktop ignores the owner of a bind mount
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$TempFiles = New-Object System.Collections.Generic.List[string]
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Say([string]$Text) { [Console]::Out.WriteLine($Text) }
function Note([string]$Text) { [Console]::Error.WriteLine($Text) }
function Fail([string]$Text) { Note "error: $Text"; exit 1 }
function Show-Usage {
  Note @'
usage: install.ps1 [-Mode local] [-Dir <folder>] [-Port <port>] -Image <image>
                   [-OwnerEmail <e-mail>] [-OwnerPasswordStdin] [-Yes]

  -Mode       local (the only mode on Windows)
  -Dir        installation folder (default %USERPROFILE%\OpenLifeDashboard\default); a fresh or an
              interrupted installation folder of this installer, never a foreign one
  -Port       host port on 127.0.0.1, 1024-65535 (default 8080)
  -Image      the application image to run
  -OwnerEmail e-mail of the owner account
  -OwnerPasswordStdin
              read the owner's password from the first line of stdin; it is never a parameter,
              a variable or a file
  -Yes        do not ask to confirm the folder when a terminal is attached
'@
}
function Usage-Error([string]$Text) { Note "error: $Text"; Show-Usage; exit 2 }

function Remove-TempFiles {
  foreach ($file in $TempFiles) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
}

# ------------------------------------------------------------------------------ small helpers

function Has-ControlCharacters([string]$Text) { return [bool]($Text -cmatch '[\x00-\x1f\x7f]') }
function Has-NonAscii([string]$Text) { return [bool]($Text -cmatch '[^\x00-\x7f]') }

function Random-Hex([int]$Bytes) {
  $buffer = New-Object byte[] $Bytes
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($buffer) } finally { $generator.Dispose() }
  return (($buffer | ForEach-Object { $_.ToString('x2') }) -join '')
}

# "27.3.1", "v2.29.1-desktop.1" -> the numbers of the first two parts
function Version-Part([string]$Version, [int]$Index) {
  $parts = $Version.TrimStart('v').Split('.')
  if ($parts.Count -lt $Index) { return 0 }
  $digits = [regex]::Match($parts[$Index - 1], '^[0-9]+').Value
  if ($digits -eq '') { return 0 }
  return [int]$digits
}

function Json-String([string]$Text) { return '"' + ($Text.Replace('\', '\\').Replace('"', '\"')) + '"' }

# Writes <Path> only when it does not exist: a temporary file in the same folder, then a rename.
# Returns $false (and writes nothing) when the file is already there.
function Write-NewFile([string]$Path, [byte[]]$Bytes) {
  if (Test-Path -LiteralPath $Path) { return $false }
  $temp = "$Path.tmp.$PID"
  $TempFiles.Add($temp)
  try { [System.IO.File]::WriteAllBytes($temp, $Bytes) } catch { Fail "cannot write ${temp}: $($_.Exception.Message)" }
  try { Move-Item -LiteralPath $temp -Destination $Path } catch { Fail "cannot create ${Path}: $($_.Exception.Message)" }
  return $true
}
function Write-NewText([string]$Path, [string]$Text) { return (Write-NewFile $Path ($Utf8NoBom.GetBytes($Text))) }
function Copy-NewFile([string]$Source, [string]$Target) {
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { Fail "missing package file: $Source" }
  return (Write-NewFile $Target ([System.IO.File]::ReadAllBytes($Source)))
}

# --------------------------------------------------------------------------------- the checks

function Test-Image([string]$Reference) {
  if ($Reference -eq '') { Usage-Error '-Image is required: this release of the installer is not run from a release package' }
  if ($Reference -cnotmatch '^[A-Za-z0-9._/:@-]+$') { Fail "the image reference contains characters that are not allowed: $Reference" }
}

# Why the e-mail would be refused by the application, or an empty string. The address is ASCII only,
# as the application's own rule is: a letter with a diacritic is refused there after the container
# has started, so it is refused here, before anything is written.
function Owner-EmailProblem([string]$Email) {
  if (Has-ControlCharacters $Email) { return 'it contains control characters' }
  if (Has-NonAscii $Email) { return 'it may use only the letters a-z, digits and . _ + - (no accented letters)' }
  if ($Email.Contains(' ')) { return 'it contains a space' }
  if ($Email.Length -gt $OwnerEmailMaxLength) { return "it is longer than $OwnerEmailMaxLength characters" }
  if ($Email.StartsWith('.') -or $Email.Contains('..')) { return 'it has a dot at the start or two dots in a row' }
  if ($Email -cnotmatch "^[A-Za-z0-9_+.'-]*[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$") { return 'it does not look like an address (name@example.com)' }
  return ''
}

function Test-OwnerEmail([string]$Email) {
  if ($Email -eq '') { return }
  $problem = Owner-EmailProblem $Email
  if ($problem -ne '') { Fail "the owner e-mail is refused: ${problem}: $Email" }
}

function Test-FolderPath([string]$Path) {
  if (Has-ControlCharacters $Path) { Fail 'the folder path contains control characters' }
  if ($Path -cmatch '[<>"|?*]') { Fail "the folder path contains a character that Windows does not allow in a name (< > "" | ? *): $Path" }
  if ($Path.Length -gt $MaxFolderChars) { Fail "the folder path is longer than $MaxFolderChars characters, which leaves too little of a Windows path for the files below it; choose a shorter one with -Dir" }
}

function Absolute-Folder([string]$Path) {
  if ($Path -eq '~') { $Path = $HOME } elseif ($Path.StartsWith('~/') -or $Path.StartsWith('~\')) { $Path = Join-Path $HOME $Path.Substring(2) }
  $full = [System.IO.Path]::GetFullPath($Path)
  $root = [System.IO.Path]::GetPathRoot($full)
  while ($full.Length -gt $root.Length -and ($full.EndsWith('\') -or $full.EndsWith('/'))) { $full = $full.Substring(0, $full.Length - 1) }
  return $full
}

function Default-Folder { return (Join-Path (Join-Path $HOME 'OpenLifeDashboard') 'default') }

function Test-System {
  if ([System.Environment]::OSVersion.Platform -ne $RequiredPlatform) {
    Fail 'this installer is for Windows; on macOS and Linux use install.sh'
  }
  $architecture = $env:PROCESSOR_ARCHITECTURE
  if ($null -ne $architecture -and $architecture -notin @('AMD64', 'ARM64')) {
    Fail "unsupported processor architecture: $architecture (amd64 and arm64 only)"
  }
}

# A native command with its output and status. Windows PowerShell 5.1 turns what a native command writes to
# stderr into a terminating error when the preference is Stop, so it is Continue for the call.
function Invoke-Docker([string[]]$Arguments) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $lines = & docker @Arguments 2>&1 | ForEach-Object { "$_" }
    return [pscustomobject]@{ Status = $LASTEXITCODE; Output = (($lines -join "`n").Trim()) }
  } finally { $ErrorActionPreference = $previous }
}

function Test-Docker {
  $docker = Get-Command docker -ErrorAction SilentlyContinue
  if ($null -eq $docker) { Fail 'Docker is not installed (the docker command was not found); install Docker Desktop and run the installer again' }
  $server = Invoke-Docker @('version', '--format', '{{.Server.Version}}|{{.Server.Os}}')
  if ($server.Status -ne 0) { Fail "the Docker daemon is not reachable; start Docker Desktop and run the installer again. Docker said: $($server.Output)" }
  $serverVersion, $serverOs = $server.Output.Split('|')
  if ($serverOs -ne 'linux') { Fail "Docker runs $serverOs containers; switch Docker Desktop to Linux containers" }
  if ((Version-Part $serverVersion 1) -lt $MinDockerMajor) { Fail "Docker Engine $serverVersion is too old; version $MinDockerMajor or newer is needed" }
  $compose = Invoke-Docker @('compose', 'version', '--short')
  if ($compose.Status -ne 0) { Fail "Docker Compose (the docker compose command) is not available. Docker said: $($compose.Output)" }
  $major = Version-Part $compose.Output 1
  $minor = Version-Part $compose.Output 2
  if ($major -lt $MinComposeMajor -or ($major -eq $MinComposeMajor -and $minor -lt $MinComposeMinor)) {
    Fail "Docker Compose $($compose.Output) is too old; version $MinComposeMajor.$MinComposeMinor or newer is needed"
  }
}

function Port-InUse([int]$PortNumber) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $pending = $client.BeginConnect('127.0.0.1', $PortNumber, $null, $null)
    if ($pending.AsyncWaitHandle.WaitOne(500)) {
      try { $client.EndConnect($pending); return $true } catch { return $false }
    }
    return $false
  } finally { $client.Close() }
}

function Test-Port([string]$Text) {
  if ($Text -cnotmatch '^[0-9]+$') { Fail "the port must be a number, got: $Text" }
  $number = [int64]$Text
  if ($number -lt $MinPort -or $number -gt $MaxPort) { Fail "the port must be between $MinPort and $MaxPort, got: $Text" }
  if (Port-InUse ([int]$number)) { Fail "port $Text is already in use on this computer; choose another with -Port" }
}

function Nearest-ExistingAncestor([string]$Path) {
  while (-not (Test-Path -LiteralPath $Path)) {
    $parent = Split-Path -Parent $Path
    if ([string]::IsNullOrEmpty($parent) -or $parent -eq $Path) { break }
    $Path = $parent
  }
  return $Path
}

function Test-Folder([string]$Path) {
  if ((Test-Path -LiteralPath $Path) -and -not (Test-Path -LiteralPath $Path -PathType Container)) { Fail "$Path exists and is not a folder" }
  $ancestor = Nearest-ExistingAncestor $Path
  if (-not (Test-Path -LiteralPath $ancestor -PathType Container)) { Fail "no permission to create $Path (cannot find a folder to write in)" }
  # Writing is tried, not guessed from attributes: a read-only folder and a denied ACL both fail here.
  $probe = Join-Path $ancestor (".openlife-write-test." + [guid]::NewGuid().ToString('N'))
  try {
    [System.IO.File]::WriteAllBytes($probe, [byte[]]@())
    Remove-Item -LiteralPath $probe -Force
  } catch { Fail "no permission to create $Path (cannot write in $ancestor)" }
  $free = (New-Object System.IO.DriveInfo ([System.IO.Path]::GetPathRoot((Resolve-Path -LiteralPath $ancestor).ProviderPath))).AvailableFreeSpace
  if ($free -lt $MinFreeBytes) { Fail "less than 1 GiB of free disk space in $ancestor" }
  # An installation folder is one that is empty, holds only folders (an interrupted first run), or
  # carries the state file of this installer. Anything else belongs to somebody else.
  $state = Join-Path (Join-Path $Path 'control') 'install-state.json'
  if ((Test-Path -LiteralPath $Path) -and -not (Test-Path -LiteralPath $state)) {
    $foreign = Get-ChildItem -LiteralPath $Path -Recurse -Force -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $foreign) { Fail "$Path is not empty and is not an installation of this installer (found $($foreign.FullName)); choose a new folder with -Dir" }
  }
}

# ----------------------------------------------------------------------------------- the state

function Stage-OfState([string]$StateFile) {
  $match = [regex]::Match([System.IO.File]::ReadAllText($StateFile), '"stage"\s*:\s*"([a-z]+)"')
  if ($match.Success) { return $match.Groups[1].Value }
  return ''
}

function Write-State([string]$StateFile, [string]$Stage) {
  $temp = "$StateFile.tmp.$PID"
  $TempFiles.Add($temp)
  $text = "{`n  `"formatVersion`": $StateFormatVersion,`n  `"stage`": `"$Stage`",`n  `"updatedAt`": `"$([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))`"`n}`n"
  try { [System.IO.File]::WriteAllText($temp, $text, $Utf8NoBom) } catch { Fail "cannot write ${temp}: $($_.Exception.Message)" }
  try { Move-Item -LiteralPath $temp -Destination $StateFile -Force } catch { Fail "cannot update ${StateFile}: $($_.Exception.Message)" }
}

function Stage-Rank([string]$Stage) {
  switch ($Stage) {
    'preparing' { return 0 } 'files' { return 1 } 'images' { return 2 }
    'started' { return 3 } 'owner' { return 4 } 'complete' { return 5 }
    default { return -1 }
  }
}

# ----------------------------------------------------------------------------------- the folder

function Project-NameOfInstance([string]$Folder) {
  $file = Join-Path (Join-Path $Folder 'control') 'instance.json'
  if (-not (Test-Path -LiteralPath $file)) { return '' }
  $match = [regex]::Match([System.IO.File]::ReadAllText($file), '"composeProjectName"\s*:\s*"(openlife-[0-9a-f]{12})"')
  if ($match.Success) { return $match.Groups[1].Value }
  return ''
}

function Prepare-Folders([string]$Folder, [string]$StateFile) {
  foreach ($sub in @('data\backup', 'data\logs\app', 'data\tmp', 'control\maintenance')) {
    $target = Join-Path $Folder $sub
    try { New-Item -ItemType Directory -Force -Path $target | Out-Null } catch { Fail "cannot create ${target}: $($_.Exception.Message)" }
  }
  # The state file is the marker that this folder is ours: it comes right after the folders.
  if (-not (Test-Path -LiteralPath $StateFile)) { Write-State $StateFile 'preparing' }
}

function Prepare-InstanceFile([string]$Folder) {
  $text = "{`n  `"formatVersion`": 1,`n  `"instanceId`": `"$([guid]::NewGuid().ToString())`",`n  `"installMode`": `"local`",`n  `"composeProjectName`": `"openlife-$(Random-Hex 6)`",`n  `"hostPlatform`": `"windows`",`n  `"installationPath`": $(Json-String $Folder),`n  `"createdAt`": `"$([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))`"`n}`n"
  if (Write-NewText (Join-Path (Join-Path $Folder 'control') 'instance.json') $text) { Say 'created control\instance.json' }
}

function Prepare-EnvFile([string]$Folder, [string]$PortText) {
  $project = Project-NameOfInstance $Folder
  if ($project -eq '') { Fail 'control\instance.json has no valid composeProjectName; the installation is damaged' }
  $lines = @(
    'INSTALL_MODE=local',
    "BASE_URL=http://localhost:$PortText",
    "BETTER_AUTH_SECRET=$(Random-Hex 32)",
    "APP_ENCRYPTION_KEY=$(Random-Hex 32)",
    'UPDATER_ENABLED=false',
    "PORT=$PortText",
    "APP_UID=$DockerUserId",
    "APP_GID=$DockerUserId",
    "COMPOSE_PROJECT_NAME=$project",
    'COMPOSE_PATH_SEPARATOR=;',
    'COMPOSE_FILE=compose.yml;compose.local.yml;control/compose.release.yml'
  )
  if (Write-NewText (Join-Path $Folder '.env') (($lines -join "`n") + "`n")) { Say 'created .env (new keys)' }
}

function Package-File([string]$Name) { # next to the installer in a release package, in docker\ in the repository
  $beside = Join-Path $ScriptDir $Name
  if (Test-Path -LiteralPath $beside -PathType Leaf) { return $beside }
  return (Join-Path (Join-Path (Split-Path -Parent $ScriptDir) 'docker') $Name)
}

function Prepare-ComposeFiles([string]$Folder, [string]$ImageReference) {
  foreach ($file in @('compose.yml', 'compose.local.yml')) {
    if (Copy-NewFile (Package-File $file) (Join-Path $Folder $file)) { Say "created $file" }
  }
  $release = "services:`n  app:`n    image: $(Json-String $ImageReference)`n"
  if (Write-NewText (Join-Path (Join-Path $Folder 'control') 'compose.release.yml') $release) { Say 'created control\compose.release.yml' }
}

# A folder that reached "files" must still hold the files that carry the identity and the keys: a
# missing one is never made up again, because the data would no longer match.
function Require-IdentityFiles([string]$Folder) {
  foreach ($file in @('control\instance.json', '.env')) {
    if (-not (Test-Path -LiteralPath (Join-Path $Folder $file))) {
      Fail "the installation is damaged: $(Join-Path $Folder $file) is missing; it is not recreated, because new keys would not open the existing data"
    }
  }
}

function Env-Value([string]$Folder, [string]$Key) {
  $match = [regex]::Match([System.IO.File]::ReadAllText((Join-Path $Folder '.env')), "(?m)^$([regex]::Escape($Key))=(.*)$")
  if ($match.Success) { return $match.Groups[1].Value.TrimEnd("`r") }
  return ''
}

# -------------------------------------------------------------------------------------- run

function Main {
  if ($Help) { Show-Usage; exit 0 }
  if ($Mode -ne 'local') {
    if ($Mode -eq 'server') { Usage-Error 'the server mode runs on Linux (Debian or Ubuntu LTS); on Windows only -Mode local is available' }
    Usage-Error "the mode '$Mode' is unknown; use local"
  }
  Test-System
  Test-Image $Image
  Test-OwnerEmail $OwnerEmail

  if ($Dir -eq '') { $Dir = Default-Folder }
  Test-FolderPath $Dir
  $folder = Absolute-Folder $Dir
  Test-FolderPath $folder
  $stateFile = Join-Path (Join-Path $folder 'control') 'install-state.json'

  Test-Docker
  Test-Folder $folder

  $resuming = Test-Path -LiteralPath $stateFile
  $currentStage = ''
  if ($resuming) {
    $currentStage = Stage-OfState $stateFile
    if ((Stage-Rank $currentStage) -lt 0) { Fail "$stateFile has an unknown stage; the installation is damaged" }
  }
  $rank = 0
  if ($currentStage -ne '') { $rank = Stage-Rank $currentStage }

  # The port of an interrupted installation is the one already in its .env; a new one is the default.
  $portText = $Port
  if ($resuming -and (Test-Path -LiteralPath (Join-Path $folder '.env'))) {
    $recorded = Env-Value $folder 'PORT'
    if ($Port -ne '' -and $recorded -ne '' -and $Port -ne $recorded) {
      Fail "this installation already uses port $recorded; run the installer without -Port, or with -Port $recorded"
    }
    if ($portText -eq '') { $portText = $recorded }
  }
  if ($portText -eq '') { $portText = "$DefaultPort" }
  # Once the application has started, the port is held by this very installation.
  if ($rank -lt 3) { Test-Port $portText }

  Say "Installation folder: $folder"
  Say "Address:             http://localhost:$portText (reachable only from this computer)"
  if ($resuming) { Say "Found an installation at the stage '$currentStage'; it is continued, nothing is overwritten." }

  if ($rank -gt 0) { Require-IdentityFiles $folder }
  Prepare-Folders $folder $stateFile
  Prepare-InstanceFile $folder
  Prepare-EnvFile $folder $portText
  Prepare-ComposeFiles $folder $Image
  if ($rank -le 0) { Write-State $stateFile 'files' }

  Say ''
  Say "The files of the installation are ready in $folder, but it is NOT installed: no container was started."
  Say '  The stages that start the application and create the owner account come with the next release of this installer.'
  Say "  Secrets:    $(Join-Path $folder '.env') - copy it to a safe place; without it the data cannot be opened"
  exit $ExitWaiting
}

try {
  Main
} finally {
  Remove-TempFiles
}
