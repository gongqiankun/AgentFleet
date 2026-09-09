import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";
import { invariant } from "./errors.js";

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const USER_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const PHRASE_WORDS = [
  "amber", "birch", "cedar", "dawn", "ember", "frost", "grove", "harbor",
  "iris", "jade", "kite", "lunar", "maple", "north", "ocean", "pine",
] as const;

export function nowIso(): string {
  return new Date().toISOString();
}

export function futureIso(seconds: number): string {
  return new Date(Date.now() + seconds * 1_000).toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(input: string | Buffer): string {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    invariant(Number.isFinite(value), 400, "INVALID_JSON_NUMBER", "JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  invariant(typeof value === "object", 400, "INVALID_JSON_VALUE", "Unsupported JSON value");
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export function payloadHash(payload: unknown): string {
  return sha256(canonicalJson(payload));
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [algorithm, nRaw, rRaw, pRaw, saltRaw, hashRaw] = encoded.split("$");
  if (algorithm !== "scrypt" || !nRaw || !rRaw || !pRaw || !saltRaw || !hashRaw) return false;
  const expected = Buffer.from(hashRaw, "base64url");
  if (expected.length !== SCRYPT_KEY_LENGTH) return false;
  try {
    const actual = scryptSync(password, Buffer.from(saltRaw, "base64url"), expected.length, {
      N: Number(nRaw),
      r: Number(rRaw),
      p: Number(pRaw),
      maxmem: 64 * 1024 * 1024,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function createUserCode(): string {
  const bytes = randomBytes(8);
  let result = "";
  for (const byte of bytes) result += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
  return `${result.slice(0, 4)}-${result.slice(4)}`;
}

export function normalizeUserCode(input: string): string {
  const compact = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  invariant(compact.length === 8, 400, "INVALID_USER_CODE", "User code must contain eight characters");
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

export function decodeHighEntropyCode(value: string): Buffer {
  invariant(value.length >= 32 && value.length <= 256, 400, "WEAK_DEVICE_CODE", "deviceCode must encode at least 32 random bytes");
  let decoded: Buffer;
  if (/^[a-fA-F0-9]{64,}$/.test(value) && value.length % 2 === 0) {
    decoded = Buffer.from(value, "hex");
  } else {
    invariant(/^[A-Za-z0-9_-]+$/.test(value), 400, "INVALID_DEVICE_CODE", "deviceCode must be base64url or hex");
    decoded = Buffer.from(value, "base64url");
  }
  invariant(decoded.length >= 32, 400, "WEAK_DEVICE_CODE", "deviceCode must contain at least 256 bits");
  return decoded;
}

export function parseEd25519PublicKey(encoded: string): KeyObject {
  try {
    const key = encoded.includes("BEGIN PUBLIC KEY")
      ? createPublicKey(encoded)
      : createPublicKey({ key: Buffer.from(encoded, "base64url"), format: "der", type: "spki" });
    invariant(key.asymmetricKeyType === "ed25519", 400, "INVALID_PUBLIC_KEY", "An Ed25519 public key is required");
    return key;
  } catch (error) {
    if (error instanceof Error && error.name === "AppError") throw error;
    throw new Error(`Invalid Ed25519 public key: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

export function normalizeEd25519PublicKey(encoded: string): string {
  const key = parseEd25519PublicKey(encoded);
  return key.export({ format: "der", type: "spki" }).toString("base64url");
}

export function publicKeyFingerprint(normalizedKey: string): string {
  const digest = createHash("sha256").update(Buffer.from(normalizedKey, "base64url")).digest("hex");
  return `SHA256:${digest.match(/.{1,4}/g)?.join(":") ?? digest}`;
}

export function verificationPhrase(normalizedKey: string, pairingId: string): string {
  const digest = createHash("sha256")
    .update(Buffer.from(normalizedKey, "base64url"))
    .update(pairingId)
    .digest();
  return Array.from(digest.subarray(0, 4), (byte) => PHRASE_WORDS[byte & 0x0f]).join("-");
}

export function verifyEd25519(normalizedKey: string, message: string, signature: string): boolean {
  try {
    return verify(
      null,
      Buffer.from(message, "utf8"),
      parseEd25519PublicKey(normalizedKey),
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

export function pairingProofMessage(pairingId: string, deviceCode: string, challenge: string): string {
  return `agentfleet-pairing-exchange-v1\n${pairingId}\n${deviceCode}\n${challenge}`;
}

export function enrollmentProofMessage(enrollmentId: string, claimToken: string, challenge: string): string {
  return `agentfleet-enrollment-exchange-v1\n${enrollmentId}\n${claimToken}\n${challenge}`;
}

function deriveEnrollmentToken(secret: string, domain: string, fields: string[]): string {
  return createHmac("sha256", decodeHighEntropyCode(secret))
    .update([domain, ...fields].join("\n"), "utf8")
    .digest("base64url");
}

/**
 * Deterministic so a claim response can be safely replayed without persisting
 * the plaintext token. The machine public key keeps a stolen bootstrap ticket
 * from rebinding an already-claimed enrollment to another identity.
 */
export function deriveEnrollmentClaimToken(
  bootstrapSecret: string,
  enrollmentId: string,
  challenge: string,
  normalizedPublicKey: string,
): string {
  return deriveEnrollmentToken(bootstrapSecret, "agentfleet-enrollment-claim-token-v1", [
    enrollmentId,
    challenge,
    normalizedPublicKey,
  ]);
}

/** Derive the recoverable Machine bearer credential from the PoP-bound claim. */
export function deriveEnrollmentAgentToken(
  claimToken: string,
  enrollmentId: string,
  challenge: string,
  machineId: string,
): string {
  return deriveEnrollmentToken(claimToken, "agentfleet-enrollment-agent-token-v1", [
    enrollmentId,
    challenge,
    machineId,
  ]);
}

export function wsChallengeMessage(
  challengeId: string,
  machineId: string,
  nonce: string,
  audience: string,
  transportGeneration: number,
): string {
  return `agentfleet-ws-challenge-v1\n${challengeId}\n${machineId}\n${nonce}\n${audience}\n${transportGeneration}`;
}
