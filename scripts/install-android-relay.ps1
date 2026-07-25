$ErrorActionPreference = "Stop"

$Device = if ($env:CARTHING_HOST) { $env:CARTHING_HOST } else { "172.16.42.2" }
$Remote = "root@$Device"
$Root = Split-Path -Parent $PSScriptRoot
$Archive = Join-Path $Root ".carthing\carthing-ma-relay.tar"
$RelaySource = Join-Path $Root "carthing-relay"

Set-Location $Root
New-Item -ItemType Directory -Force (Split-Path -Parent $Archive) | Out-Null
if (Test-Path $Archive) { Remove-Item $Archive -Force }

& tar.exe -cf $Archive -C $RelaySource relay_service.py vendor
if ($LASTEXITCODE -ne 0) { throw "Unable to create the Car Thing relay archive." }

Write-Host "Uploading the Bluetooth relay to $Remote."
Write-Host "The default Nocturne SSH password is: nocturne"
& scp -o StrictHostKeyChecking=accept-new $Archive (Join-Path $PSScriptRoot "device\install-android-relay-device.sh") "${Remote}:/tmp/"
if ($LASTEXITCODE -ne 0) { throw "Relay upload failed." }

& ssh -o StrictHostKeyChecking=accept-new $Remote "sh /tmp/install-android-relay-device.sh"
if ($LASTEXITCODE -ne 0) { throw "Relay installation failed." }

Write-Host "Car Thing Bluetooth relay installed on RFCOMM channel 3."
