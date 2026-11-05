import { createHash, createPublicKey, verify } from "node:crypto";
import { call, type ApiConfig } from "./api.js";

/**
 * Receipt checks, the same way as the standalone verify-receipt.mjs on pagenull.dev/verify: the signature is
 * Ed25519 over the receipt's payload part exactly as sent, checked with the public key published at
 * /.well-known/pagenull-keys.json. Nothing is sent to pagenull but the request for the public keys.
 */

export interface ReceiptPayload {
  v: number;
  kid: string;
  render_id: string;
  sha256: string;
  timestamp: string;
  region: string;
  renderer: string;
  stored: boolean;
}

export type VerifyResult =
  | { valid: true; payload: ReceiptPayload; fileMatches: boolean | null }
  | { valid: false; reason: string; fileMatches: null };

export interface Jwks {
  keys: { kid: string; x: string }[];
}

export async function fetchKeys(cfg: ApiConfig): Promise<Jwks> {
  const res = await call(cfg, "GET", "/.well-known/pagenull-keys.json", undefined, false);
  return JSON.parse(res.body.toString("utf8")) as Jwks;
}

export const sha256Hex = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** `expectedSha256` is the SHA-256 of the file to check against the receipt, if there is one. */
export function verifyReceipt(receipt: string, keys: Jwks, expectedSha256?: string | null): VerifyResult {
  const value = receipt.trim().replace(/^pagenull-receipt:\s*/i, "");
  const [version, payloadPart, signaturePart] = value.split(".");
  if (version !== "v1" || !payloadPart || !signaturePart) return { valid: false, reason: "Not a pagenull v1 receipt", fileMatches: null };
  let payload: ReceiptPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as ReceiptPayload;
  } catch {
    return { valid: false, reason: "The receipt payload isn't valid JSON", fileMatches: null };
  }
  const jwk = keys.keys.find((k) => k.kid === payload.kid);
  if (!jwk) return { valid: false, reason: `Unknown key id ${payload.kid}`, fileMatches: null };
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });
  const ok = verify(null, Buffer.from(payloadPart), key, Buffer.from(signaturePart, "base64url"));
  if (!ok) return { valid: false, reason: "The signature doesn't match", fileMatches: null };
  return { valid: true, payload, fileMatches: expectedSha256 ? expectedSha256.toLowerCase() === payload.sha256 : null };
}
