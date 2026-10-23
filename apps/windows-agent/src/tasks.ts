import { runPowerShell } from './powershell.js';

/**
 * Autostart: a Scheduled Task that runs the agent at the current user's logon and restarts it if it dies.
 * (Not a Windows service: DPAPI CurrentUser scope and per-user printers need the user's profile, and we do not ship a
 * third-party service wrapper.) The executable path reaches the script through stdin as JSON, not through interpolation.
 */
export const TASK_NAME = 'PrintoutBuddyAgent';

const INSTALL = `
$cfg = [Console]::In.ReadToEnd() | ConvertFrom-Json
$action = New-ScheduledTaskAction -Execute $cfg.exe -Argument $cfg.args
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $cfg.name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
[Console]::Out.Write('OK')
`;
const UNINSTALL = `
$cfg = [Console]::In.ReadToEnd() | ConvertFrom-Json
if (Get-ScheduledTask -TaskName $cfg.name -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $cfg.name -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $cfg.name -Confirm:$false }
[Console]::Out.Write('OK')
`;
const QUERY = `
$cfg = [Console]::In.ReadToEnd() | ConvertFrom-Json
$t = Get-ScheduledTask -TaskName $cfg.name -ErrorAction SilentlyContinue
if ($t) { [Console]::Out.Write([string]$t.State) } else { [Console]::Out.Write('NotInstalled') }
`;

export async function installAutostart(exe: string, args = 'run'): Promise<void> {
  const r = await runPowerShell(INSTALL, JSON.stringify({ name: TASK_NAME, exe, args }), 60_000);
  if (r.code !== 0 || r.stdout.trim() !== 'OK') throw new Error('Could not create the scheduled task');
}
export async function removeAutostart(): Promise<void> {
  const r = await runPowerShell(UNINSTALL, JSON.stringify({ name: TASK_NAME }), 60_000);
  if (r.code !== 0) throw new Error('Could not remove the scheduled task');
}
export async function autostartState(): Promise<string> {
  const r = await runPowerShell(QUERY, JSON.stringify({ name: TASK_NAME }), 30_000);
  return r.code === 0 ? r.stdout.trim() || 'Unknown' : 'Unknown';
}
