# One-time admin grant: allow the current (non-elevated) DSH process to
# start/stop the cloudflared service. Required because the service is installed
# as SYSTEM and its security descriptor only lets administrators control it.
#
# Run ONCE as administrator:
#   powershell -ExecutionPolicy Bypass -File scripts\grant-tunnel-control.ps1
#
$ErrorActionPreference = 'Stop'
$id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($id)
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Warning 'Please run this script as administrator.'
  exit 1
}
$sid = $id.User.Value
Write-Host "granting start/stop on service 'cloudflared' to $sid"

$lines = sc.exe sdshow cloudflared
$sddl = ($lines | Where-Object { $_ -match 'D:\(' }) -join ''
$sddl = $sddl.Trim()
if (-not $sddl) { Write-Warning 'could not read the service SDDL.'; exit 1 }

$newSddl = $sddl -replace '^D:\(', "D:(A;;RPWP;;;$sid)("
Write-Host "new SDDL: $newSddl"
$result = sc.exe sdset cloudflared $newSddl
Write-Host $result

# Self-verify from a non-elevated perspective is not possible here (this shell
# is elevated), so just report. The DSH settings switch should now work.
Write-Host 'Done. The Cloudflare tunnel switch in DSH settings should now work.'