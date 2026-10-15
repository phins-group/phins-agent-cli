# Install the reviewed Windows x64 release for this user, without elevation.
& {
  $ErrorActionPreference = 'Stop'

  if ($env:OS -ne 'Windows_NT') { throw 'Use install.sh on macOS or Linux.' }
  if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -ne 'X64') {
    throw 'This release supports Windows x64; Windows ARM64 and x86 are unsupported.'
  }
  if ([Environment]::OSVersion.Version.Build -lt 17763) { throw 'Windows 10 1809 or newer is required.' }
  if (-not $env:LOCALAPPDATA -or -not [IO.Path]::IsPathRooted($env:LOCALAPPDATA)) {
    throw 'LOCALAPPDATA must be an absolute path.'
  }

  $label = 'phins-0.1.1-local-windows-x64'
  $archiveSha256 = '1eb79020e7866006fa0d856959bd96ac26da22be33b4fede5b6d6eb0959764de'
  $binarySha256 = 'ce17717672fa371125bcc9141f54a5fb297a8609982e42d2b9b129d8284edcc7'
  $base = Join-Path $env:LOCALAPPDATA 'PHINsAgent'
  $bin = Join-Path $base 'bin'
  $bundle = Join-Path $base $label
  $binary = Join-Path $bundle 'phins.exe'
  $launcher = Join-Path $bin 'phins.cmd'
  $launcherText = "@rem PHINs Agent installer launcher`r`n@`"%~dp0..\$label\phins.exe`" %*`r`n"

  foreach ($path in @($base, $bin, $bundle, $launcher, $binary)) {
    if ((Test-Path -LiteralPath $path) -and ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Installation path must not be a link: $path"
    }
  }
  if (Test-Path -LiteralPath $launcher) {
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
      Write-Host 'Downloading PHINs Agent 0.1.1 for windows-x64...'
      Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/phins-group/phins-agent-cli/releases/download/v0.1.1/$label.zip" -OutFile $archive -TimeoutSec 300
      if ((Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant() -ne $archiveSha256) {
        throw 'Archive checksum mismatch; nothing installed.'
      }
      Expand-Archive -LiteralPath $archive -DestinationPath $stage
      $extracted = Join-Path $stage $label
      $candidate = Join-Path $extracted 'phins.exe'
      if ((Get-FileHash -Algorithm SHA256 -LiteralPath $candidate).Hash.ToLowerInvariant() -ne $binarySha256) {
        throw 'Executable checksum mismatch.'
      }
      & $candidate --version
      if ($LASTEXITCODE -ne 0) { throw 'The executable cannot run on this Windows installation.' }
      [IO.File]::WriteAllText((Join-Path $extracted '.phins-install'), $archiveSha256)
      if (Test-Path -LiteralPath $bundle) { throw 'Another installation appeared; preserved.' }
      Move-Item -LiteralPath $extracted -Destination $bundle
    } finally {
      Remove-Item -LiteralPath $stage -Recurse -Force
    }
  }
  if (-not (Test-Path -LiteralPath $launcher)) {
    $bytes = [Text.Encoding]::ASCII.GetBytes($launcherText)
    $file = [IO.File]::Open($launcher, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
    try { $file.Write($bytes, 0, $bytes.Length) } finally { $file.Dispose() }
  }
  Write-Host "Installed: $launcher"
  Write-Host "Demo files: $bundle"
  Write-Host "Run: & `"$launcher`""
}
