/**
 * Parsed authentication data and extracted public key from an attestationObject.
 */
export interface ParsedAttestation {
  /** SHA-256 hash of the RP ID. */
  rpIdHash: Uint8Array;
  /** Authenticator data flags byte. */
  flags: number;
  /** Signature counter value. */
  signCount: number;
  /** AAGUID of the authenticator in hex format. */
  aaguid: string;
  /** Credential ID in Base64URL format. */
  credentialId: string;
  /** SPKI-encoded public key in Base64URL format. */
  publicKeySpki: string;
  /** COSE algorithm identifier (-7 for ES256, -257 for RS256). */
  algorithm: number;
}

/**
 * Options for validating a client's WebAuthn registration response.
 */
export interface VerifyRegistrationOptions {
  /** Client data JSON in Base64URL format. */
  clientDataJSON: string;
  /** Attestation object in Base64URL format. */
  attestationObject: string;
  /** Expected challenge string in Base64URL format. */
  expectedChallenge: string;
  /** Expected origin URL (e.g. "https://dns.example.com"). */
  expectedOrigin: string;
  /** Expected RP ID (e.g. "dns.example.com"). */
  expectedRpId: string;
}

/**
 * Options for validating a client's WebAuthn assertion (authentication) response.
 */
export interface VerifyAuthenticationOptions {
  /** Client data JSON in Base64URL format. */
  clientDataJSON: string;
  /** Authenticator data in Base64URL format. */
  authenticatorData: string;
  /** Signature in Base64URL format (ASN.1 DER for ES256). */
  signature: string;
  /** SPKI-encoded public key in Base64URL format. */
  publicKeySpki: string;
  /** COSE algorithm identifier (-7 for ES256, -257 for RS256). */
  algorithm: number;
  /** Expected challenge string in Base64URL format. */
  expectedChallenge: string;
  /** Expected origin URL. */
  expectedOrigin: string;
  /** Expected RP ID. */
  expectedRpId: string;
  /** Previously recorded sign count to prevent replay/cloned authenticators. */
  previousSignCount?: number;
}
