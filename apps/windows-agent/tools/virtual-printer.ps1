<#
  Creates (or removes) a TEST printer named "PB-Test-Printer" for hardware-free end-to-end checks.
  It uses the built-in "Microsoft Print To PDF" driver on a FILE port inside your temp folder, so nothing physical is touched
  and no real customer document should ever be sent to it.

  Needs an ELEVATED PowerShell (Add-Printer / Add-PrinterPort). It never modifies existing printers.
    .\virtual-printer.ps1 -Create
    .\virtual-printer.ps1 -Remove
  Output lands in %TEMP%\PB-Test-Printer\out.pdf (overwritten per job).
  A virtual printer proves the Windows spooler path; it does NOT prove a physical printer (REAL HARDWARE PRINTING UNVERIFIED).
#>
param([switch]$Create, [switch]$Remove)
$ErrorActionPreference = 'Stop'
$name = 'PB-Test-Printer'
$dir = Join-Path $env:TEMP 'PB-Test-Printer'
$port = Join-Path $dir 'out.pdf'
if ($Create) {
  if (Get-Printer -Name $name -ErrorAction SilentlyContinue) { Write-Host "$name already exists"; exit 0 }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  if (-not (Get-PrinterPort -Name $port -ErrorAction SilentlyContinue)) { Add-PrinterPort -Name $port }
  Add-Printer -Name $name -DriverName 'Microsoft Print To PDF' -PortName $port
  Write-Host "Created $name -> $port"
} elseif ($Remove) {
  if (Get-Printer -Name $name -ErrorAction SilentlyContinue) { Remove-Printer -Name $name }
  if (Get-PrinterPort -Name $port -ErrorAction SilentlyContinue) { Remove-PrinterPort -Name $port }
  Write-Host "Removed $name"
} else { Write-Host 'Use -Create or -Remove'; exit 2 }
