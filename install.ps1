# Install the reviewed Windows x64 release for this user, without elevation.
& {
  $ErrorActionPreference = 'Stop'

  if ($PSVersionTable.PSVersion.Major -lt 5 -or
      ($PSVersionTable.PSVersion.Major -eq 5 -and $PSVersionTable.PSVersion.Minor -lt 1)) {
    throw 'PowerShell 5.1 or newer is required. Use Windows PowerShell 5.1 or PowerShell 7.'
  }
  if ($env:OS -ne 'Windows_NT') { throw 'Use install.sh on macOS or Linux.' }
  # WOW64 exposes the native CPU separately from a 32-bit PowerShell process.
  $architecture = $env:PROCESSOR_ARCHITEW6432
  if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
  if (-not [Environment]::Is64BitOperatingSystem -or $architecture -ne 'AMD64') {
    throw 'This release supports Windows x64; Windows ARM64 and x86 are unsupported.'
  }
  if ([Environment]::OSVersion.Version.Build -lt 17763) { throw 'Windows 10 1809 or newer is required.' }
  if (-not $env:LOCALAPPDATA -or -not [IO.Path]::IsPathRooted($env:LOCALAPPDATA)) {
    throw 'LOCALAPPDATA must be an absolute path.'
  }

  $label = 'phins-0.1.2-local-windows-x64'
  $archiveSha256 = '09416da249be66f8eaa65d3941205ddea00407a367f8fa32e393849c715a47ef'
  $binarySha256 = 'c457f50aa7b7be2e460aee4cc56c5aaf09fa3db124aaab80162affb0e5e3bf50'
  $base = Join-Path $env:LOCALAPPDATA 'PHINsAgent'
  $bin = Join-Path $base 'bin'
  $bundle = Join-Path $base $label
  $binary = Join-Path $bundle 'phins.exe'
  $launcher = Join-Path $bin 'phins.cmd'
  $rootLauncher = Join-Path $bundle 'phins.cmd'
  $launcherSha256 = '59fe3f7d9fbb1ec9144865ff4649d453266a72c20a8ba4c5d4c5e2709a4378ec'
  $launcherText = $null

  foreach ($path in @($base, $bin, $bundle, $launcher, $binary, $rootLauncher)) {
    if ((Test-Path -LiteralPath $path) -and ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Installation path must not be a link: $path"
    }
  }
  if (Test-Path -LiteralPath $launcher) {
    if (-not (Test-Path -LiteralPath $rootLauncher -PathType Leaf) -or (Get-FileHash -Algorithm SHA256 -LiteralPath $rootLauncher).Hash.ToLowerInvariant() -ne $launcherSha256) {
      throw "Existing command preserved: $launcher"
    }
    $launcherText = [IO.File]::ReadAllText($rootLauncher).Replace('%~dp0phins.exe', "%~dp0..\$label\phins.exe")
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf) -or [IO.File]::ReadAllText($launcher) -ne $launcherText) {
      throw "Existing command preserved: $launcher"
    }
  }
  New-Item -ItemType Directory -Path $base, $bin -Force | Out-Null
  if (Test-Path -LiteralPath $bundle) {
    $receipt = Join-Path $bundle '.phins-install'
    if (-not (Test-Path -LiteralPath $receipt -PathType Leaf) -or -not (Test-Path -LiteralPath $binary -PathType Leaf)) {
      throw "Existing directory preserved: $bundle"
    }
    if ([IO.File]::ReadAllText($receipt).Trim() -ne $archiveSha256 -or (Get-FileHash -Algorithm SHA256 -LiteralPath $binary).Hash.ToLowerInvariant() -ne $binarySha256) {
      throw "Existing installation changed; preserved: $bundle"
    }
    Write-Host 'PHINs Agent is already installed (windows-x64).'
  } else {
    $stage = Join-Path $base ('.install-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage | Out-Null
    try {
      $archive = Join-Path $stage 'release.zip'
      Write-Host 'Downloading PHINs Agent 0.1.2 for windows-x64...'
      Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/phins-group/phins-agent-cli/releases/download/v0.1.2/$label.zip" -OutFile $archive -TimeoutSec 300
      if ((Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant() -ne $archiveSha256) {
        throw 'Archive checksum mismatch; nothing installed.'
      }
      Expand-Archive -LiteralPath $archive -DestinationPath $stage
      $extracted = Join-Path $stage $label
      $candidate = Join-Path $extracted 'phins.exe'
      if ((Get-FileHash -Algorithm SHA256 -LiteralPath $candidate).Hash.ToLowerInvariant() -ne $binarySha256) {
        throw 'Executable checksum mismatch.'
      }
      if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $extracted 'phins.cmd')).Hash.ToLowerInvariant() -ne $launcherSha256) {
        throw 'Windows launcher checksum mismatch.'
      }
      [IO.File]::WriteAllText((Join-Path $extracted '.phins-install'), $archiveSha256)
      if (Test-Path -LiteralPath $bundle) { throw 'Another installation appeared; preserved.' }
      Move-Item -LiteralPath $extracted -Destination $bundle
    } finally {
      Remove-Item -LiteralPath $stage -Recurse -Force
    }
  }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $rootLauncher).Hash.ToLowerInvariant() -ne $launcherSha256) {
    throw 'Installed Windows launcher changed; preserved.'
  }
  # Probe at the final location: Windows can retain a lock after executing an image.
  & $binary --version
  if ($LASTEXITCODE -ne 0) { throw 'The executable cannot run on this Windows installation.' }
  $launcherText = [IO.File]::ReadAllText($rootLauncher).Replace('%~dp0phins.exe', "%~dp0..\$label\phins.exe")
  if (-not (Test-Path -LiteralPath $launcher)) {
    $bytes = [Text.Encoding]::ASCII.GetBytes($launcherText)
    $file = [IO.File]::Open($launcher, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
    try { $file.Write($bytes, 0, $bytes.Length) } finally { $file.Dispose() }
  }
  Write-Host "Installed: $launcher"
  Write-Host "Demo files: $bundle"
  Write-Host "Run: & `"$launcher`""
}
