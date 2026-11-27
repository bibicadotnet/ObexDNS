/**
 * Apple macOS / iOS / iPadOS / tvOS Configuration Profile (.mobileconfig) Generator
 * Generates an Apple configuration profile (XML plist) for DNS-over-HTTPS (DoH).
 * When key is omitted, configures for the server's default profile (canonical /dns-query).
 */

export interface AppleMobileConfigOptions {
  origin: string;
  key?: string;
  profileName?: string;
  accessPointName?: string;
  appName?: string;
}

export function formatProfileLabel(profileName?: string, accessPointName?: string, appName?: string): string {
  let p = (profileName || '').trim().replace(/\s+/g, ' ');
  let ap = (accessPointName || '').trim().replace(/\s+/g, ' ');

  if (!ap && p.includes('(') && p.endsWith(')')) {
    const match = p.match(/^(.+?)\s*\((.+?)\)$/);
    if (match) {
      p = match[1].trim();
      ap = match[2].trim();
    }
  }

  const isDefaultName = (name: string) => name === 'DNS Worker' || name === 'DNS Shield' || Boolean(appName && name === appName);
  const cleanP = p && !isDefaultName(p) ? p : '';
  const cleanAp = ap && !isDefaultName(ap) ? ap : '';

  if (cleanP && cleanAp) {
    if (cleanP.toLowerCase() === cleanAp.toLowerCase()) {
      return cleanP;
    }
    return `${cleanP} - ${cleanAp}`;
  }

  return cleanP || cleanAp || '';
}

export function generateAppleMobileConfig(options: AppleMobileConfigOptions): string {
  const cleanOrigin = (options.origin || '').replace(/\/+$/, '');
  let domain = 'obexdns';
  try {
    domain = new URL(cleanOrigin).hostname;
  } catch {
    domain = cleanOrigin.replace(/^https?:\/\//, '').split('/')[0].split(':')[0] || 'obexdns';
  }

  const key = (options.key || '').trim();
  const dohUrl = key ? `${cleanOrigin}/${key}` : `${cleanOrigin}/dns-query`;
  const appName = options.appName?.trim() || 'DNS Shield';
  const label = formatProfileLabel(options.profileName, options.accessPointName, appName);

  const payloadUUID = crypto.randomUUID();
  const profileUUID = crypto.randomUUID();

  const displayName = label
    ? `${appName} - ${domain} (${label})`
    : key
    ? `${appName} - ${domain} (${key})`
    : `${appName} (${domain})`;

  const dohPayloadName = label
    ? `${appName} DoH - ${domain} (${label})`
    : `${appName} DoH - ${domain}`;

  const description = label
    ? `${appName} DoH configuration profile for ${label} via ${domain}`
    : `${appName} DoH configuration profile via ${domain}`;

  const payloadDescription = label
    ? `Configures encrypted DNS over HTTPS (DoH) for ${label} via ${domain}`
    : `Configures encrypted DNS over HTTPS (DoH) via ${domain}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>PayloadContent</key>
\t<array>
\t\t<dict>
\t\t\t<key>DNSSettings</key>
\t\t\t<dict>
\t\t\t\t<key>DNSProtocol</key>
\t\t\t\t<string>HTTPS</string>
\t\t\t\t<key>ServerHTTPVersion</key>
\t\t\t\t<integer>3</integer>
\t\t\t\t<key>ServerURL</key>
\t\t\t\t<string>${dohUrl}</string>
\t\t\t</dict>
\t\t\t<key>OnDemandRules</key>
\t\t\t<array>
\t\t\t\t<dict>
\t\t\t\t\t<key>Action</key>
\t\t\t\t\t<string>Connect</string>
\t\t\t\t\t<key>InterfaceTypeMatch</key>
\t\t\t\t\t<string>WiFi</string>
\t\t\t\t</dict>
\t\t\t\t<dict>
\t\t\t\t\t<key>Action</key>
\t\t\t\t\t<string>Connect</string>
\t\t\t\t\t<key>InterfaceTypeMatch</key>
\t\t\t\t\t<string>Cellular</string>
\t\t\t\t</dict>
\t\t\t\t<dict>
\t\t\t\t\t<key>Action</key>
\t\t\t\t\t<string>Disconnect</string>
\t\t\t\t</dict>
\t\t\t</array>
\t\t\t<key>PayloadDescription</key>
\t\t\t<string>${payloadDescription}</string>
\t\t\t<key>PayloadDisplayName</key>
\t\t\t<string>${dohPayloadName}</string>
\t\t\t<key>PayloadIdentifier</key>
\t\t\t<string>com.apple.dnsSettings.managed.${payloadUUID}</string>
\t\t\t<key>PayloadName</key>
\t\t\t<string>${dohPayloadName}</string>
\t\t\t<key>PayloadType</key>
\t\t\t<string>com.apple.dnsSettings.managed</string>
\t\t\t<key>PayloadUUID</key>
\t\t\t<string>${payloadUUID}</string>
\t\t\t<key>PayloadVersion</key>
\t\t\t<integer>1</integer>
\t\t</dict>
\t</array>
\t<key>PayloadDescription</key>
\t<string>${description}</string>
\t<key>PayloadDisplayName</key>
\t<string>${displayName}</string>
\t<key>PayloadIdentifier</key>
\t<string>com.dnsworker.profile.${key || 'default'}</string>
\t<key>PayloadName</key>
\t<string>${displayName}</string>
\t<key>PayloadRemovalDisallowed</key>
\t<false/>
\t<key>PayloadScope</key>
\t<string>System</string>
\t<key>PayloadType</key>
\t<string>Configuration</string>
\t<key>PayloadUUID</key>
\t<string>${profileUUID}</string>
\t<key>PayloadVersion</key>
\t<integer>1</integer>
</dict>
</plist>
`;
}
