// Prints a fresh VAPID key pair for WEB_PUSH_PUBLIC_KEY / WEB_PUSH_PRIVATE_KEY.
// Put the private key only into the hosting environment, never into git.
import { createECDH } from "node:crypto";
const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
console.log("WEB_PUSH_PUBLIC_KEY=" + ecdh.getPublicKey().toString("base64url"));
const d = ecdh.getPrivateKey();
console.log("WEB_PUSH_PRIVATE_KEY=" + Buffer.concat([Buffer.alloc(32 - d.length), d]).toString("base64url"));
