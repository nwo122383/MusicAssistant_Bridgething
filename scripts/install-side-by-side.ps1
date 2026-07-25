$ErrorActionPreference = "Stop"

$Device = if ($env:CARTHING_HOST) { $env:CARTHING_HOST } else { "172.16.42.2" }
$Remote = "root@$Device"
$Root = Split-Path -Parent $PSScriptRoot
$Archive = Join-Path $Root ".carthing\carthing-ma-side-by-side.tar"
$BridgeConfigPath = Join-Path $Root ".carthing\bridge-config.json"
$DeviceConfigPath = Join-Path $Root "dist\device-config.json"

Set-Location $Root
New-Item -ItemType Directory -Force (Split-Path -Parent $Archive) | Out-Null

& npm.cmd run build:device
if ($LASTEXITCODE -ne 0) { throw "Device build failed." }

if (-not (Test-Path $BridgeConfigPath)) {
  throw "The PC bridge is not configured. Run 'npm.cmd run bridge', then open http://localhost:4173/setup first."
}
$BridgeConfig = Get-Content $BridgeConfigPath -Raw | ConvertFrom-Json
if (-not $BridgeConfig.token) { throw "The saved PC bridge configuration does not contain a Music Assistant token." }
$DeviceConfig = @{
  serverUrl = "http://127.0.0.1:4173/mass"
  token = $BridgeConfig.token
} | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($DeviceConfigPath, $DeviceConfig, [System.Text.UTF8Encoding]::new($false))

if (Test-Path $Archive) { Remove-Item $Archive -Force }
& tar.exe -cf $Archive -C (Join-Path $Root "dist") .
if ($LASTEXITCODE -ne 0) { throw "Unable to create the device archive." }
Remove-Item $DeviceConfigPath -Force

Write-Host "Uploading the side-by-side app to $Remote."
Write-Host "The default Nocturne SSH password is: nocturne"
& scp -o StrictHostKeyChecking=accept-new $Archive (Join-Path $PSScriptRoot "device\install-side-by-side-device.sh") "${Remote}:/tmp/"
if ($LASTEXITCODE -ne 0) { throw "Upload failed." }

& ssh -o StrictHostKeyChecking=accept-new $Remote "sh /tmp/install-side-by-side-device.sh"
if ($LASTEXITCODE -ne 0) { throw "Device installation failed." }

Write-Host "Installed. Nocturne remains the default UI; use its MA button to switch."
