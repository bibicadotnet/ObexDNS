import { normalizeIconDomain, isIconlessHost, iconLookupHosts } from "../src/utils/websiteIcon";

function eq(a: unknown, b: unknown, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}
eq(normalizeIconDomain("github.com.ico"), "github.com", "strips .ico");
eq(normalizeIconDomain("Edge.Microsoft.COM.ico"), "edge.microsoft.com", "lower-case");
eq(normalizeIconDomain("example.com..ico"), "example.com", "trailing dot");
eq(normalizeIconDomain("%2A.example.com.ico"), "example.com", "wildcard prefix");
eq(normalizeIconDomain("_dmarc.example.com.ico"), "_dmarc.example.com", "underscore label");
eq(normalizeIconDomain("xn--bcher-kva.example.ico"), "xn--bcher-kva.example", "punycode label");
eq(normalizeIconDomain("a/b.com.ico"), null, "slash rejected");
eq(normalizeIconDomain("..com.ico"), null, "empty label rejected");
eq(normalizeIconDomain("localhost.ico"), null, "single label rejected");
eq(normalizeIconDomain("1.1.1.1.ico"), null, "ip literal rejected");
eq(isIconlessHost("4.3.2.1.in-addr.arpa"), true, "PTR has no icon");
eq(isIconlessHost("printer.lan"), true, ".lan has no icon");
eq(isIconlessHost("github.com"), false, "public site");
eq(iconLookupHosts("microsoft.com"), ["microsoft.com"], "registrable only");
eq(iconLookupHosts("a.b.c.example.com"), ["a.b.c.example.com", "example.com"], "host then registrable, max 2");
eq(iconLookupHosts("www.bbc.co.uk"), ["www.bbc.co.uk", "bbc.co.uk"], "co.uk kept whole");
console.log("test_website_icon: OK");
