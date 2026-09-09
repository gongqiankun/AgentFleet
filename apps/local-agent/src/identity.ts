import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
} from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat, open, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { KeyObject } from "node:crypto";
import type { IdentityMetadata } from "./types.js";
import type { StateStore } from "./store.js";
import { nowIso } from "./util.js";

const PHRASE_WORDS = [
  "amber", "birch", "cedar", "delta", "ember", "fern", "granite", "harbor",
  "iris", "juniper", "kite", "lunar", "maple", "north", "ocean", "pine",
  "quartz", "river", "spruce", "tiger", "umber", "violet", "willow", "xenon",
  "yellow", "zenith", "acorn", "brook", "coral", "dawn", "elm", "frost",
] as const;
const execFileAsync = promisify(execFile);

async function restrictPrivateKey(path: string): Promise<boolean> {
  if (process.platform !== "win32") {
    try {
      await chmod(path, 0o600);
      const keyStat = await lstat(path);
      return keyStat.isFile() && (keyStat.mode & 0o777) === 0o600;
    } catch {
      return false;
    }
  }
  try {
    const { stdout } = await execFileAsync("whoami.exe", [], { timeout: 5_000, encoding: "utf8" });
    const account = stdout.trim();
    if (!account || /[\r\n]/u.test(account)) return false;
    await execFileAsync("icacls.exe", [path, "/inheritance:r", "/grant:r", `${account}:(F)`], {
      timeout: 10_000,
      windowsHide: true,
      encoding: "utf8",
    });
    return true;
  } catch {
    return false;
  }
}

async function createPrivateKeyFile(path: string, pem: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(pem, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function metadataFor(privateKey: KeyObject, protection: IdentityMetadata["credentialProtectionLevel"]): IdentityMetadata {
  const publicKey = createPublicKey(privateKey);
  const spki = publicKey.export({ type: "spki", format: "der" });
  const digest = createHash("sha256").update(spki).digest();
  const fingerprintHex = digest.toString("hex");
  const fingerprint = `SHA256:${fingerprintHex.match(/.{1,4}/g)?.join(":") ?? fingerprintHex}`;
  const verificationPhrase = Array.from(digest.subarray(0, 6), (byte) => PHRASE_WORDS[byte & 31]).join("-");
  return {
    algorithm: "Ed25519",
    publicKey: spki.toString("base64url"),
    fingerprint,
    verificationPhrase,
    credentialProtectionLevel: protection,
    createdAt: nowIso(),
  };
}

export interface MachineIdentity {
  metadata: IdentityMetadata;
  sign(data: string | Uint8Array): string;
}

export async function loadOrCreateIdentity(store: StateStore): Promise<MachineIdentity> {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(await readFile(store.privateKeyPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const generated = generateKeyPairSync("ed25519");
    const pem = generated.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    try {
      await createPrivateKeyFile(store.privateKeyPath, pem);
      privateKey = generated.privateKey;
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
      privateKey = createPrivateKey(await readFile(store.privateKeyPath, "utf8"));
    }
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("machine identity key must be Ed25519");
  }

  const protection: IdentityMetadata["credentialProtectionLevel"] = await restrictPrivateKey(store.privateKeyPath)
    ? "software_protected"
    : "unknown";
  const fresh = metadataFor(privateKey, protection);
  const existing = store.snapshot().identity;
  const metadata: IdentityMetadata = {
    ...fresh,
    createdAt: existing?.fingerprint === fresh.fingerprint ? existing.createdAt : fresh.createdAt,
  };
  await store.setIdentity(metadata);
  return {
    metadata,
    sign(data) {
      return cryptoSign(null, typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data), privateKey).toString("base64url");
    },
  };
}
