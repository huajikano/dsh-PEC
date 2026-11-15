# Update the locally installed dsh-pec plugin from a released tag.
#
#   pwsh ./scripts/sync-local.ps1 [-ProfileDir <dir>] [-Version v2.0.5]
#
# What it does:
#   1. Pins the profile dependency to the given tag (profile package.json).
#   2. Runs pnpm update so node_modules picks up the released tarball.
#   3. Prints activation guidance (web changes are live immediately; lib
#      changes need a plugin toggle in DSH settings). The script never
#      toggles the plugin itself - that mechanism once orphaned a disabled
#      flag into another entry and took DSH down.
#
# Safe usage pattern:
#   - web/* changes:   no reload needed at all (gateway serves from disk).
#   - lib/* changes:   toggle the plugin in DSH settings after running this.
#
param(
  [string]$ProfileDir = "$env:USERPROFILE\.dsh\profiles\desktop",
  [string]$Version = 'v2.0.3',
  [int]$Port = 7317
)
$ErrorActionPreference = 'Stop'

# 1) Pin the dependency to the released tag.
$pkg = Join-Path $ProfileDir 'package.json'
$manifest = Get-Content $pkg -Raw | ConvertFrom-Json
$specifier = "github:huajikano/dsh-PEC#$Version"
if ($manifest.dependencies.'dsh-pec' -ne $specifier) {
  $manifest.dependencies.'dsh-pec' = $specifier
  # WriteAllText with UTF8(false) avoids the BOM that Set-Content -Encoding UTF8
  # adds on Windows PowerShell 5 - a BOM here crashes DSH's readProfileManifest.
  [System.IO.File]::WriteAllText($pkg, ($manifest | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
  # Belt-and-braces: verify no BOM landed in the file.
  $bomCheck = [System.IO.File]::ReadAllBytes($pkg)
  if ($bomCheck.Length -ge 3 -and $bomCheck[0] -eq 0xEF -and $bomCheck[1] -eq 0xBB -and $bomCheck[2] -eq 0xBF) {
    throw 'package.json was written with a BOM - refusing to continue (this crashes DSH at startup)'
  }
  Write-Host "pinned dsh-pec to $specifier"
} else {
  Write-Host "dsh-pec already pinned to $specifier"
}

# 2) Let pnpm fetch the released tarball into node_modules.
Push-Location $ProfileDir
try { pnpm update dsh-pec 2>&1 | Select-Object -Last 3 } finally { Pop-Location }

# 3) Activation guidance (and the risky reload only on explicit request).
if (-not $Reload) {
  Write-Host ''
  Write-Host 'activation guide:'
  Write-Host '  - web/* changes:        live already, just refresh the phone page.'
  Write-Host '  - lib/* changes:        toggle dsh-pec in DSH plugin settings'
  Write-Host '                           (or rerun this script with -Reload).'
  exit 0
}

# Activation is manual by design: toggling the plugin through the gateway API
# left a disabled flag in unpredictable places (once it orphaned into the
# subagent row and took the whole DSH down). Keep it human-controlled.
Write-Host ''
Write-Host 'lib/* changes need a plugin reload - do it in DSH:'
Write-Host '  Settings -> Plugins -> dsh-pec -> disable, then enable.'
Write-Host 'If the gateway does not come back, restart DSH - that always fixes it.'

# 4) Verify the profile patch file is structurally healthy after everything:
#    every "disabled: true" line must sit directly under an id/name row of its
#    own entry - an orphaned one merges into the previous entry in YAML and
#    can disable something unrelated (this once disabled the core subagent
#    plugin and took every session down).
$patch = Join-Path $ProfileDir 'cordis.patch.yml'
$lines = [System.IO.File]::ReadAllLines($patch)
$orphans = @()
for ($i = 1; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match '^\s*disabled:\s*(true|false)\s*$') {
    $prev = $lines[$i - 1]
    $isOwnRow = $prev -match '^\s*(- id:|name:|enabled:|config:|disabled:|version:)'
    if (-not $isOwnRow) { $orphans += ($i + 1) }
  }
}
if ($orphans.Count -gt 0) {
  Write-Warning ("orphaned disabled lines detected in cordis.patch.yml at: " + ($orphans -join ', '))
  Write-Warning 'an orphan merges into the previous YAML entry and can break DSH - fix manually.'
  exit 1
}
Write-Host 'patch.yml structure OK.'
exit 0
exit 1