$ErrorActionPreference = "Stop"

$Device = if ($env:CARTHING_HOST) { $env:CARTHING_HOST } else { "172.16.42.2" }
$Remote = "root@$Device"

Write-Host "Setting Music Assistant as the default UI on $Remote."
Write-Host "The default Nocturne SSH password is: nocturne"
& scp -o StrictHostKeyChecking=accept-new (Join-Path $PSScriptRoot "device\set-ma-default-device.sh") "${Remote}:/tmp/"
if ($LASTEXITCODE -ne 0) { throw "Upload failed." }

& ssh -o StrictHostKeyChecking=accept-new $Remote "sh /tmp/set-ma-default-device.sh"
if ($LASTEXITCODE -ne 0) { throw "Unable to set Music Assistant as default." }

Write-Host "Done. Chromium now starts at Nocturne briefly, then automatically opens Music Assistant."
