export { DNS_TYPES, DNS_TYPE_TO_CODE } from "./constants";
export {
  decodeName,
  getQTypeName,
  parseDNSQuery,
  parseDNSQueryFromRaw,
  parseDNSAnswer
} from "./decoder";
export {
  buildDNSQuery,
  buildResponse,
  buildResponseMulti,
  createServFail
} from "./encoder";
export { encodeRData } from "./rdata";
export { capResponseTtl } from "./ttl";
export {
  injectEcsIntoQuery,
  stripEcsFromQuery,
  stripEcsFromResponse,
  disableEcsInQuery,
  parseEcsCidr,
  formatEcsSubnet
} from "./injectEcs";
export type { EcsSubnet } from "./injectEcs";
export type { DNSRecord } from "./encoder";
