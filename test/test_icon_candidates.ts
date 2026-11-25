import { iconCandidates, MAX_ICON_ATTEMPTS } from "../src/utils/iconCandidates";

const eq = (got: unknown, want: unknown, label: string): void => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

eq(iconCandidates("edge.microsoft.com"), ["edge.microsoft.com", "microsoft.com"], "subdomain falls back to parent");
eq(iconCandidates("microsoft.com"), ["microsoft.com"], "registrable domain is never stripped");
eq(iconCandidates("a.b.c.example.com").length <= MAX_ICON_ATTEMPTS, true, "bounded attempts");
eq(iconCandidates("a.b.c.example.com"), ["a.b.c.example.com", "b.c.example.com", "c.example.com", "example.com"], "deep chain");
eq(iconCandidates("www.bbc.co.uk"), ["www.bbc.co.uk", "bbc.co.uk"], "co.uk is kept whole");
eq(iconCandidates("bbc.co.uk"), ["bbc.co.uk"], "co.uk registrable");
eq(iconCandidates("mail.example.com.vn"), ["mail.example.com.vn", "example.com.vn"], "com.vn is kept whole");
eq(iconCandidates("Edge.Microsoft.COM")[0], "edge.microsoft.com", "lower-cased");
console.log("test_icon_candidates: OK");
