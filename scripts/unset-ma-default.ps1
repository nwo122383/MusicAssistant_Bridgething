$ErrorActionPreference = "Stop"

$Device = if ($env:CARTHING_HOST) { $env:CARTHING_HOST } else { "172.16.42.2" }
$Remote = "root@$Device"

Write-Host "Restoring Nocturne as the default UI on $Remote."
Write-Host "The default Nocturne SSH password is: nocturne"
& scp -o StrictHostKeyChecking=accept-new (Join-Path $PSScriptRoot "device\unset-ma-default-device.sh") "${Remote}:/tmp/"
if ($LASTEXITCODE -ne 0) { throw "Upload failed." }

& ssh -o StrictHostKeyChecking=accept-new $Remote "sh /tmp/unset-ma-default-device.sh"
if ($LASTEXITCODE -ne 0) { throw "Unable to restore Nocturne as default." }

Write-Host "Done. Nocturne is the default UI again."
