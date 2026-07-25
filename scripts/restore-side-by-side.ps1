$ErrorActionPreference = "Stop"

$Device = if ($env:CARTHING_HOST) { $env:CARTHING_HOST } else { "172.16.42.2" }
$Remote = "root@$Device"

Write-Host "Restoring the original Nocturne UI on $Remote."
Write-Host "The default Nocturne SSH password is: nocturne"
& scp -o StrictHostKeyChecking=accept-new (Join-Path $PSScriptRoot "device\restore-side-by-side-device.sh") "${Remote}:/tmp/"
if ($LASTEXITCODE -ne 0) { throw "Upload failed." }

& ssh -o StrictHostKeyChecking=accept-new $Remote "sh /tmp/restore-side-by-side-device.sh"
if ($LASTEXITCODE -ne 0) { throw "Device restoration failed." }

Write-Host "Original Nocturne UI restored."
