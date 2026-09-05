$ErrorActionPreference = 'Continue'
$env:PATH = "$env:LOCALAPPDATA\Programs\Nodejs;$env:USERPROFILE\.cargo\bin;$env:PATH"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $PSScriptRoot
$log = Join-Path $PSScriptRoot 'build.log'
"=== BUILD START $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Out-File -FilePath $log -Encoding utf8
& npm run tauri build -- --bundles nsis *>&1 | Out-File -FilePath $log -Encoding utf8 -Append
"=== EXITCODE=$LASTEXITCODE ===" | Out-File -FilePath $log -Encoding utf8 -Append
if ($LASTEXITCODE -eq 0) {
  $bundleDir = Join-Path $PSScriptRoot 'src-tauri\target\release\bundle\nsis'
  $copied = @()
  Get-ChildItem $bundleDir -Filter '*-setup.exe' -ErrorAction SilentlyContinue | ForEach-Object {
    Copy-Item $_.FullName -Destination (Join-Path $root $_.Name) -Force
    $copied += $_.Name
  }
  "=== COPIED TO ROOT: $($copied -join ';') ===" | Out-File -FilePath $log -Encoding utf8 -Append
}
"=== BUILD END $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Out-File -FilePath $log -Encoding utf8 -Append
