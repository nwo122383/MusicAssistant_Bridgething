$ErrorActionPreference = "Stop"

$Device = if ($env:CARTHING_HOST) { $env:CARTHING_HOST } else { "172.16.42.2" }
$Remote = "root@$Device"

Write-Host "Removing the MA Bluetooth relay from $Remote."
Write-Host "The default Nocturne SSH password is: nocturne"
& scp -o StrictHostKeyChecking=accept-new (Join-Path $PSScriptRoot "device\remove-android-relay-device.sh") "${Remote}:/tmp/"
if ($LASTEXITCODE -ne 0) { throw "Removal script upload failed." }

& ssh -o StrictHostKeyChecking=accept-new $Remote "sh /tmp/remove-android-relay-device.sh"
if ($LASTEXITCODE -ne 0) { throw "Relay removal failed." }
