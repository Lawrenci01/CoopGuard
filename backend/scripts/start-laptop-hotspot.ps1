param(
  [string]$Ssid,
  [string]$Passphrase,
  [switch]$DhcpFallback,
  [switch]$SkipTls,
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$cgBackend = Split-Path -Parent $PSScriptRoot
$cgLocal = Join-Path $cgBackend '.local'
$cgConfigPath = Join-Path $cgLocal 'hotspot-config.json'
$cgDhcpPidPath = Join-Path $cgLocal 'dhcp.pid'

function Stop-CoopGuardDhcp {
  if (-not (Test-Path -LiteralPath $cgDhcpPidPath)) { return }
  $dhcpPid = [int](Get-Content -LiteralPath $cgDhcpPidPath -Raw)
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$dhcpPid" -ErrorAction SilentlyContinue
  if ($process -and $process.Name -eq 'node.exe' -and $process.CommandLine -like '*src/localDhcp.ts*') {
    Stop-Process -Id $dhcpPid -Force
  }
  Remove-Item -LiteralPath $cgDhcpPidPath -Force -ErrorAction SilentlyContinue
}

function Start-CoopGuardDhcp {
  param([string]$Address)
  if (Test-Path -LiteralPath $cgDhcpPidPath) {
    $dhcpPid = [int](Get-Content -LiteralPath $cgDhcpPidPath -Raw)
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$dhcpPid" -ErrorAction SilentlyContinue
    if ($process -and $process.Name -eq 'node.exe' -and $process.CommandLine -like '*src/localDhcp.ts*') {
      Write-Output "CoopGuard DHCP fallback already running (PID $dhcpPid)."
      return
    }
    Remove-Item -LiteralPath $cgDhcpPidPath -Force -ErrorAction SilentlyContinue
  }
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $process = Start-Process -FilePath $node -ArgumentList @('--import', 'tsx', 'src/localDhcp.ts', '--address', $Address) -WorkingDirectory $cgBackend -WindowStyle Hidden -RedirectStandardOutput (Join-Path $cgLocal 'dhcp.out.log') -RedirectStandardError (Join-Path $cgLocal 'dhcp.err.log') -PassThru
  $process.Id | Set-Content -LiteralPath $cgDhcpPidPath
  Start-Sleep -Milliseconds 750
  if ($process.HasExited) {
    $details = if (Test-Path -LiteralPath (Join-Path $cgLocal 'dhcp.err.log')) {
      (Get-Content -LiteralPath (Join-Path $cgLocal 'dhcp.err.log') -Tail 8) -join [Environment]::NewLine
    } else {
      'No DHCP error log was written.'
    }
    Remove-Item -LiteralPath $cgDhcpPidPath -Force -ErrorAction SilentlyContinue
    throw "The CoopGuard DHCP fallback failed to start.$([Environment]::NewLine)$details"
  }
  Write-Output "CoopGuard DHCP fallback started on $Address (PID $($process.Id))."
}

function Wait-WinRtOperation {
  param($Operation, [string]$Label)
  while ([string]$Operation.Status -eq 'Started') {
    Start-Sleep -Milliseconds 100
  }
  if ([string]$Operation.Status -eq 'Canceled') {
    throw "$Label was cancelled."
  }
  if ([string]$Operation.Status -eq 'Error') {
    throw "$Label failed: $($Operation.ErrorCode.Message)"
  }
}

function New-RandomPassphrase {
  $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  $bytes = New-Object byte[] 18
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  return -join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
}

function Get-HotspotManager {
  $null = [Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType = WindowsRuntime]
  $null = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager, Windows.Networking.NetworkOperators, ContentType = WindowsRuntime]
  $profile = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()
  if (-not $profile) {
    $profile = [Windows.Networking.Connectivity.NetworkInformation]::GetConnectionProfiles() |
      Where-Object { [string]$_.GetNetworkConnectivityLevel() -ne 'None' } |
      Select-Object -First 1
  }
  if (-not $profile) {
    throw 'Windows Mobile Hotspot needs an active WiFi or Ethernet connection profile during laptop setup.'
  }
  return [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::CreateFromConnectionProfile($profile)
}

function Find-HotspotAddress {
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $candidate = Get-NetIPConfiguration -ErrorAction SilentlyContinue |
      Where-Object {
        $_.NetAdapter.InterfaceDescription -like '*Wi-Fi Direct Virtual Adapter*' -and
        $_.IPv4Address -and
        $_.NetAdapter.Status -eq 'Up'
      } |
      ForEach-Object { $_.IPv4Address.IPAddress } |
      Where-Object { $_ -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)' } |
      Select-Object -First 1
    if ($candidate) { return $candidate }
    Start-Sleep -Milliseconds 500
  }
  throw 'The hotspot started, but Windows did not assign its private IPv4 address.'
}

$manager = Get-HotspotManager
if ($Stop) {
  Stop-CoopGuardDhcp
  if ([string]$manager.TetheringOperationalState -ne 'Off') {
    $null = Wait-WinRtOperation $manager.StopTetheringAsync() 'Stopping CoopGuard hotspot'
  }
  Write-Output 'CoopGuard laptop hotspot stopped.'
  exit 0
}

try {
  if ([Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::IsNoConnectionsTimeoutEnabled()) {
    [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::DisableNoConnectionsTimeout()
  }
} catch {
  Write-Warning 'Windows could not disable the five-minute no-client hotspot timeout. Keep the phone connected or restart the hub before scanning.'
}

$saved = $null
if (Test-Path -LiteralPath $cgConfigPath) {
  $saved = Get-Content -LiteralPath $cgConfigPath -Raw | ConvertFrom-Json
}
$useDhcpFallback = $DhcpFallback.IsPresent -or ($saved -and $saved.dhcpFallback -eq $true)
if (-not $Ssid) {
  $Ssid = if ($saved -and $saved.ssid) {
    [string]$saved.ssid
  } else {
    $suffix = ([Guid]::NewGuid().ToString('N').Substring(0, 6)).ToUpperInvariant()
    "CoopGuard-Hub-$suffix"
  }
}
if (-not $Passphrase) {
  $Passphrase = if ($saved -and $saved.passphrase) {
    [string]$saved.passphrase
  } else {
    New-RandomPassphrase
  }
}
if ($Ssid.Length -lt 1 -or $Ssid.Length -gt 32) {
  throw 'The hotspot SSID must contain 1 to 32 characters.'
}
if ($Passphrase.Length -lt 8 -or $Passphrase.Length -gt 63) {
  throw 'The hotspot passphrase must contain 8 to 63 characters.'
}

$current = $manager.GetCurrentAccessPointConfiguration()
$matches = $current.Ssid -eq $Ssid -and $current.Passphrase -eq $Passphrase
if ([string]$manager.TetheringOperationalState -ne 'Off' -and -not $matches) {
  $null = Wait-WinRtOperation $manager.StopTetheringAsync() 'Stopping the previous hotspot'
}
if (-not $matches) {
  $current.Ssid = $Ssid
  $current.Passphrase = $Passphrase
  $null = Wait-WinRtOperation $manager.ConfigureAccessPointAsync($current) 'Configuring CoopGuard hotspot'
}
if ([string]$manager.TetheringOperationalState -ne 'On') {
  $null = Wait-WinRtOperation $manager.StartTetheringAsync() 'Starting CoopGuard hotspot'
  for ($attempt = 0; $attempt -lt 40 -and [string]$manager.TetheringOperationalState -ne 'On'; $attempt++) {
    Start-Sleep -Milliseconds 250
  }
  if ([string]$manager.TetheringOperationalState -ne 'On') {
    throw 'Windows did not turn on Mobile Hotspot. Open Windows Mobile Hotspot settings and confirm that sharing is available.'
  }
}

$hotspotIp = Find-HotspotAddress
$wifiUrl = "https://${hotspotIp}:8443"
$payload = [ordered]@{
  schemaVersion = 1
  ssid = $Ssid
  passphrase = $Passphrase
  wifiUrl = $wifiUrl
  dhcpFallback = [bool]$useDhcpFallback
  updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
} | ConvertTo-Json
if (-not (Test-Path -LiteralPath $cgLocal)) {
  New-Item -ItemType Directory -Path $cgLocal | Out-Null
}
[System.IO.File]::WriteAllText(
  $cgConfigPath,
  "$payload$([Environment]::NewLine)",
  (New-Object System.Text.UTF8Encoding($false))
)

$isAdministrator = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
if ($isAdministrator) {
  $ruleName = 'CoopGuard Laptop Hub HTTPS'
  $hotspotInterface = (Get-NetIPAddress -IPAddress $hotspotIp -AddressFamily IPv4 -ErrorAction Stop).InterfaceAlias
  $rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  if ($rule) {
    $rule | Set-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -Profile Any -InterfaceAlias $hotspotInterface | Out-Null
    $rule | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter -RemoteAddress LocalSubnet | Out-Null
    $rule | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort 8443 | Out-Null
  } else {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8443 -Profile Any -InterfaceAlias $hotspotInterface -RemoteAddress LocalSubnet | Out-Null
  }
  if ($useDhcpFallback) {
    $dhcpRuleName = 'CoopGuard Laptop Hub DHCP'
    $dhcpRule = Get-NetFirewallRule -DisplayName $dhcpRuleName -ErrorAction SilentlyContinue
    if ($dhcpRule) {
      $dhcpRule | Set-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -Profile Any -InterfaceAlias $hotspotInterface | Out-Null
      $dhcpRule | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter -RemoteAddress Any | Out-Null
      $dhcpRule | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol UDP -LocalPort 67 | Out-Null
    } else {
      New-NetFirewallRule -DisplayName $dhcpRuleName -Direction Inbound -Action Allow -Protocol UDP -LocalPort 67 -Profile Any -InterfaceAlias $hotspotInterface -RemoteAddress Any | Out-Null
    }
  }
} else {
  Write-Warning 'Run this command once as Administrator if Windows Firewall blocks phone access to TCP port 8443.'
}

if ($useDhcpFallback) {
  Start-CoopGuardDhcp -Address $hotspotIp
} else {
  Stop-CoopGuardDhcp
}

if (-not $SkipTls) {
  & (Get-Command node.exe -ErrorAction Stop).Source (Join-Path $cgBackend 'scripts\create-local-tls.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Could not refresh the local HTTPS certificate.' }
}

Write-Output "CoopGuard hotspot is ready: $Ssid"
Write-Output "Hub address: $wifiUrl"
Write-Output "DHCP source: $(if ($useDhcpFallback) { 'CoopGuard fallback' } else { 'Windows ICS' })"
Write-Output "Private hotspot configuration: $cgConfigPath"
Write-Output 'The passphrase is stored locally and will be embedded only in the short-lived hub pairing QR.'
