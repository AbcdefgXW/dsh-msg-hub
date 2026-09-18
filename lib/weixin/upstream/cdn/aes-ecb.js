/**
 * Shared AES-128-ECB crypto utilities for CDN upload and download.
 */
import { createCipheriv, createDecipheriv } from "node:crypto";
/** Encrypt buffer with AES-128-ECB (PKCS7 padding is default). */
export function encryptAesEcb(plaintext, key) {
    const cipher = createCipheriv("aes-128-ecb", key, null);
    return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}
/** Decrypt buffer with AES-128-ECB (PKCS7 padding). */
export function decryptAesEcb(ciphertext, key) {
    const decipher = createDecipheriv("aes-128-ecb", key, null);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
/** Compute AES-128-ECB ciphertext size (PKCS7 padding to 16-byte boundary). */
export function aesEcbPaddedSize(plaintextSize) {
    return Math.ceil((plaintextSize + 1) / 16) * 16;
}
//# sourceMappingURL=aes-ecb.js.map