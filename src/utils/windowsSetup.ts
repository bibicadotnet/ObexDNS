/**
 * Windows Automated Setup PowerShell Script Generator
 * Configures dnsproxy (DoH/DoT) + Zapret (WinWS DPI bypass) as auto-starting Windows services.
 */

export interface WindowsSetupOptions {
  origin: string;
  /** Profile / access point key. Omitted = default profile (DoH at /dns-query, DoT at the bare domain). */
  key?: string;
  dotDomain?: string;
  packageUrl?: string;
}

export function generateWindowsSetupScript(options: WindowsSetupOptions): string {
  const cleanOrigin = (options.origin || '').replace(/\/+$/, '');
  let hostname = 'obexdns';
  try {
    hostname = new URL(cleanOrigin).hostname;
  } catch {
    hostname = cleanOrigin.replace(/^https?:\/\//, '').split('/')[0].split(':')[0] || 'obexdns';
  }

  // Derive hostSlug from hostname (e.g. "user.bibica.net" -> "user-bibica-net")
  const hostSlug = hostname.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'obexdns';

  const defaultToolsUrl = 'https://github.com/bibicadotnet/ObexDNS/releases/download/windows-tools-setup/windows-tools-setup.zip';
  const packageUrl = options.packageUrl && options.packageUrl.trim() ? options.packageUrl.trim() : defaultToolsUrl;

  // No key: use the server's default profile (DoH canonical /dns-query, DoT on the bare domain).
  const key = (options.key || '').trim();
  const dohUpstream = key ? `${cleanOrigin}/${key}` : `${cleanOrigin}/dns-query`;
  const cleanDotDomain = (options.dotDomain || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  const dotUpstreamLine = cleanDotDomain ? `  - tls://${key ? `${key}.` : ''}${cleanDotDomain}` : '';

  const reElevateUrl = key ? `${cleanOrigin}/setup.ps1?key=${encodeURIComponent(key)}` : `${cleanOrigin}/setup.ps1`;

  return `# ${hostname} DoH/DoT + Zapret DPI bypass - Auto Installer
if (!([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(544)) {
    Start-Process powershell.exe '-NoProfile -ExecutionPolicy Bypass -Command "irm \\"${reElevateUrl}\\" | iex"' -Verb RunAs
    exit
}
Clear-Host
\$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = 'Tls12'

# ---- Shared code: used by the installer AND written out as uninstall.ps1 ----
\$lib = {
    \$ErrorActionPreference = \$WarningPreference = 'SilentlyContinue'
    \$dir    = 'C:\\${hostSlug}-doh'
    \$svc    = '${hostSlug}-winws', '${hostSlug}-dnsproxy'
    \$backup = "\$dir\\dns-backup.txt"

    function Say(\$m, \$c = 'Gray') { Write-Host \$m -ForegroundColor \$c }
    function Get-Adapters { Get-NetAdapter | ? InterfaceDescription -notlike '*Loopback*' }

    # Reset both IPv4/IPv6 DNS, then apply any static servers ("DHCP" = leave automatic)
    function Set-Dns(\$i, \$v4, \$v6) {
        Set-DnsClientServerAddress -InterfaceIndex \$i -ResetServerAddresses
        foreach (\$s in \$v4, \$v6) { if (\$s -and \$s -ne 'DHCP') { Set-DnsClientServerAddress -InterfaceIndex \$i -ServerAddresses (\$s -split ',') } }
    }

    function Restore-Dns {
        \$b = @(Import-Csv \$backup -Encoding UTF8)
        if (\$b.Count -and -not (\$b.DNSv4 -match '127\\.0\\.0\\.1')) {
            \$b | % { Set-Dns \$_.InterfaceIndex \$_.DNSv4 \$_.DNSv6 }
        } else {
            Say '  No valid DNS backup, using fallback DNS (8.8.8.8, 1.1.1.1)' Yellow
            Get-Adapters | % { Set-Dns \$_.ifIndex '8.8.8.8,1.1.1.1' }
        }
    }

    function Unload-WinDivert {
        Get-CimInstance Win32_SystemDriver -Filter "Name LIKE 'WinDivert%'" | % { sc.exe stop \$_.Name; sc.exe delete \$_.Name } | Out-Null
        Start-Sleep 2
    }

    function Remove-Install {
        if (Test-Path \$dir) { Restore-Dns }
        Stop-Service \$svc -Force
        Stop-Process -Name dnsproxy, winws, goodbyedpi, net, net1 -Force
        Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" | ? CommandLine -like '*${hostSlug}-startup.vbs*' | % { Stop-Process -Id \$_.ProcessId -Force }
        Remove-Item "\$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\${hostSlug}.lnk" -Force -ErrorAction SilentlyContinue
        Unregister-ScheduledTask ${hostSlug}-startup -Confirm:\$false -ErrorAction SilentlyContinue
        \$svc | % { sc.exe delete \$_ } | Out-Null
        Wait-Process -Name dnsproxy, winws -Timeout 3
        Unload-WinDivert
        for (\$i = 0; \$i -lt 2 -and (Test-Path \$dir); \$i++) { Remove-Item \$dir -Recurse -Force; Start-Sleep 2 }
    }
}
. \$lib

# ---- Installer-only helpers ----
function Fail(\$m) { Say "\`nERROR: \$m\`n" Red; Read-Host 'Press Enter to exit'; exit }

function Test-LocalDns {
    for (\$i = 0; \$i -lt 16; \$i++) {
        if (Resolve-DnsName google.com -Server 127.0.0.1 -DnsOnly -QuickTimeout) { return \$true }
        Start-Sleep -m 500
    }
}

function New-Svc(\$n, \$exe, \$p, \$disp, \$desc, \$dep) {
    & \$dir\\nssm.exe install \$n \$exe
    @{ AppDirectory = (Split-Path \$exe); AppParameters = \$p; DisplayName = \$disp; Description = \$desc; Start = 'SERVICE_AUTO_START' }.GetEnumerator() |
        % { & \$dir\\nssm.exe set \$n \$_.Key \$_.Value }
    sc.exe config \$n depend= \$dep
}

Say "\`n${hostname} DoH/DoT & Zapret DPI bypass - Auto Installer\`n" Cyan

# ---- Cleanup previous install ----
if (Test-Path \$dir) { Say 'Found existing installation, restoring DNS and cleaning up...' }
Remove-Install
if (Test-Path \$dir) { Fail 'Cannot remove existing installation. WinDivert driver may be locked - restart your computer and run the installer again.' }

# ---- Backup DNS ----
Say 'Backing up current DNS settings...'
New-Item -ItemType Directory "\$dir\\dnsproxy", "\$dir\\zapret" -Force | Out-Null
Get-Adapters | % {
    \$i = \$_.ifIndex
    \$d = 'IPv4', 'IPv6' | % { \$s = (Get-DnsClientServerAddress -InterfaceIndex \$i -AddressFamily \$_).ServerAddresses -join ','; if (\$s) { \$s } else { 'DHCP' } }
    [pscustomobject]@{ Name = \$_.Name; InterfaceIndex = \$i; DNSv4 = \$d[0]; DNSv6 = \$d[1] }
} | Export-Csv \$backup -NoTypeInformation -Encoding UTF8

# ---- Download package ----
Say 'Downloading ${hostSlug} package...'
\$zip = "\$env:TEMP\\${hostSlug}-tools.zip"
try {
    Invoke-WebRequest "${packageUrl}" -OutFile \$zip -UseBasicParsing -EA Stop
    Expand-Archive \$zip \$dir -Force -EA Stop
} catch { Fail "Failed to download package: \$_" }
Remove-Item \$zip

# ---- Config files ----
@'
listen-addrs:
  - 127.0.0.1
listen-ports:
  - 53
upstream:
  - ${dohUpstream}
${dotUpstreamLine}
bootstrap:
  - 1.1.1.1
  - 8.8.8.8
  - 9.9.9.9
  - 208.67.222.222
cache: false
'@ | Set-Content "\$dir\\dnsproxy\\config.yaml" -Encoding ASCII

# Zapret matches subdomains automatically, so www./store./api. variants are not needed
-split 'pornhub.com linkedin.com medium.com bilibili.tv bbc.com bbc.co.uk steamcommunity.com steampowered.com
steamusercontent.com steamstatic.com rsload.net xvideos.com xvideos2.com xvideos3.com xnxx.com xhamster.com nyaa.si
lrepacks.net voa.gov rfa.org amnesty.org pastebin.com paste.ee javhd.today javhd.com spankbang.com javmost.com
beeg.com sextop1.net sextop1.sale youporn.com www.wattpad.com mangadex.org fitgirl-repacks.site voatiengviet.com
voz.vn rou.video' | Set-Content "\$dir\\zapret\\blacklist.txt" -Encoding ASCII

# ---- Helper scripts ----
@'
@echo off
net session >nul 2>&1 || (powershell Start-Process '%~f0' -Verb RunAs & exit /b)
net stop ${hostSlug}-dnsproxy /y
net stop ${hostSlug}-winws /y
ipconfig /flushdns
net start ${hostSlug}-winws
net start ${hostSlug}-dnsproxy
pause
'@ | Set-Content "\$dir\\${hostSlug}-restart.bat" -Encoding ASCII

@"
@echo off
net session >nul 2>&1 || (powershell Start-Process '%~f0' -Verb RunAs & exit /b)
cd /d %TEMP%
powershell -NoProfile -ExecutionPolicy Bypass -File "\$dir\\uninstall.ps1"
pause
"@ | Set-Content "\$dir\\uninstall.bat" -Encoding ASCII

"\$lib\`nSet-Location \`$env:TEMP\`nRemove-Install\`nif (Test-Path \`$dir) { Say 'Some files are locked - delete \$dir after reboot' Yellow } else { Say 'Uninstall complete' Green }" |
    Set-Content "\$dir\\uninstall.ps1" -Encoding UTF8

# ---- Hosts file must exist ----
\$hosts = "\$env:SystemRoot\\System32\\drivers\\etc\\hosts"
if (!(Test-Path \$hosts)) { "# Default hosts file\`r\`n# 127.0.0.1 localhost\`r\`n# ::1 localhost" | Set-Content \$hosts -Encoding ASCII }

# ---- Create & start services, verify DNS ----
Say 'Creating and starting services...'
New-Svc ${hostSlug}-winws "\$dir\\zapret\\winws.exe" '--wf-tcp=80,443 --wf-udp=443 --hostlist=blacklist.txt --dpi-desync=fake,disorder2 --dpi-desync-fooling=badseq --dpi-desync-repeats=6' 'Zapret WinWS DPI Bypass' 'DPI bypass service for blocked websites' Tcpip *>\$null
New-Svc ${hostSlug}-dnsproxy "\$dir\\dnsproxy\\dnsproxy.exe" '--config-path=config.yaml --output=dnsproxy.log' 'DNSProxy DoH Service' 'DNS over HTTPS proxy using ${hostname}' Tcpip/${hostSlug}-winws *>\$null
try {
    \$svc | % { Start-Service \$_ -EA Stop; Start-Sleep -m 500 }
    if (!(Test-LocalDns)) { throw 'Services are running but DNS queries fail' }
} catch {
    Stop-Service \$svc -Force
    Restore-Dns
    Fail "\$_\`nCheck log: \$dir\\dnsproxy\\dnsproxy.log"
}

# ---- Point system DNS to 127.0.0.1 ----
Say 'Configuring system DNS...'
foreach (\$a in Get-Adapters) { Set-Dns \$a.ifIndex 127.0.0.1 }
Clear-DnsClientCache

# ---- CDN check (display only) ----
Say "Verifying CDN Vietnam Optimization...\`n"
\$ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
if (\$me = Invoke-RestMethod https://api.ip.sb/geoip -UserAgent \$ua -TimeoutSec 5) {
    Say "Your Location: \$(\$me.city), \$(\$me.country)\`nYour ISP:      \$(\$me.asn_organization)\`n" Cyan
}
foreach (\$t in 'Tiktok.com v16-webapp-prime.tiktok.com', 'Bilibili.com upos-hz-mirrorakam.akamaized.net', 'Apple.com www.apple.com',
               'Amazon.com www.amazon.com', 'Ebay.com www.ebay.com', 'Douyin.com v3-dy-o.zjcdn.com',
               'Bilibili.tv www.bilibili.tv', 'Shopee.vn cf.shopee.vn', 'Lazada.vn img.lazcdn.com') {
    \$n, \$d = \$t -split ' '
    Start-Sleep -m 200
    \$p = Test-Connection \$d -Count 1
    if (!\$p) { Say "  \$(\$n.PadRight(15)) Error / Timeout" Red; continue }
    \$ms = \$p.ResponseTime
    \$l  = Invoke-RestMethod "https://ipinfo.io/\$(\$p.IPV4Address)/json" -TimeoutSec 5
    \$c  = if (\$ms -lt 10) { 'Green' } elseif (\$ms -lt 20) { 'Yellow' } else { 'Red' }
    Say "  \$(\$n.PadRight(15)) (\${ms}ms)\$(if (\$l) { " (\$($l.city), \$($l.org))" })" \$c
}

# ---- Done ----
# Only what was just configured is highlighted (Cyan); green/yellow/red stay reserved for the CDN latency test above.
Say "\`n========================================\`nInstallation complete!\`n========================================\`n" DarkGray
Say "System DNS: 127.0.0.1 (${hostname} DoH/DoT + Zapret DPI bypass)\`nServices:   running, auto-start on boot\`n" Cyan
Say "Install location: \$dir\`nRestart services: \$dir\\${hostSlug}-restart.bat\`nUninstall:        \$dir\\uninstall.bat\`n" Cyan
Say 'Press any key to exit...' DarkGray
\$null = \$Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
`;
}
