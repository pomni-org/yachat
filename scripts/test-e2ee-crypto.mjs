import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

const crypto = webcrypto;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ALGORITHM = "yachat-x3dh-v1";

function concat(parts) {
  const arrays = parts.map((part) => part instanceof Uint8Array ? part : new Uint8Array(part));
  const output = new Uint8Array(arrays.reduce((sum, item) => sum + item.length, 0));
  let offset = 0;
  for (const item of arrays) {
    output.set(item, offset);
    offset += item.length;
  }
  return output;
}

function randomBytes(length) {
  const result = new Uint8Array(length);
  crypto.getRandomValues(result);
  return result;
}

async function x25519() {
  return crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
}

async function rawPublic(key) {
  return new Uint8Array(await crypto.subtle.exportKey("raw", key));
}

async function dh(privateKey, publicKey) {
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: publicKey }, privateKey, 256));
}

async function deriveWrapKey(parts, salt, info, usage) {
  const material = await crypto.subtle.importKey("raw", concat(parts), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    [usage]
  );
}

async function roundTrip(useOneTimePreKey) {
  const senderIdentity = await x25519();
  const recipientIdentity = await x25519();
  const recipientSigned = await x25519();
  const recipientOneTime = useOneTimePreKey ? await x25519() : null;
  const ephemeral = await x25519();

  const signing = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const signedPublic = await rawPublic(recipientSigned.publicKey);
  const signature = await crypto.subtle.sign("Ed25519", signing.privateKey, signedPublic);
  assert.equal(
    await crypto.subtle.verify("Ed25519", signing.publicKey, signature, signedPublic),
    true,
    "signed prekey must verify"
  );

  const senderDh = [
    await dh(senderIdentity.privateKey, recipientSigned.publicKey),
    await dh(ephemeral.privateKey, recipientIdentity.publicKey),
    await dh(ephemeral.privateKey, recipientSigned.publicKey)
  ];
  const recipientDh = [
    await dh(recipientSigned.privateKey, senderIdentity.publicKey),
    await dh(recipientIdentity.privateKey, ephemeral.publicKey),
    await dh(recipientSigned.privateKey, ephemeral.publicKey)
  ];
  if (recipientOneTime) {
    senderDh.push(await dh(ephemeral.privateKey, recipientOneTime.publicKey));
    recipientDh.push(await dh(recipientOneTime.privateKey, ephemeral.publicKey));
  }
  assert.deepEqual(concat(senderDh), concat(recipientDh), "X3DH input must agree on both devices");

  const messageId = crypto.randomUUID();
  const recipientDeviceId = "device-recipient-test";
  const salt = randomBytes(32);
  const info = encoder.encode(`${ALGORITHM}|envelope|${messageId}|${recipientDeviceId}`);
  const senderWrap = await deriveWrapKey(senderDh, salt, info, "encrypt");
  const recipientWrap = await deriveWrapKey(recipientDh, salt, info, "decrypt");
  const contentKeyBytes = randomBytes(32);
  const envelopeIv = randomBytes(12);
  const wrapped = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: envelopeIv, additionalData: info },
    senderWrap,
    contentKeyBytes
  );
  const unwrapped = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: envelopeIv, additionalData: info },
    recipientWrap,
    wrapped
  ));
  assert.deepEqual(unwrapped, contentKeyBytes, "recipient must unwrap the exact content key");

  const contentAad = encoder.encode(`${ALGORITHM}|content|private-test|${messageId}|device-sender-test`);
  const contentIv = randomBytes(12);
  const plaintext = encoder.encode(JSON.stringify({ text: "E2EE test", messageId }));
  const encryptKey = await crypto.subtle.importKey("raw", contentKeyBytes, "AES-GCM", false, ["encrypt"]);
  const decryptKey = await crypto.subtle.importKey("raw", unwrapped, "AES-GCM", false, ["decrypt"]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: contentIv, additionalData: contentAad },
    encryptKey,
    plaintext
  );
  const opened = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: contentIv, additionalData: contentAad },
    decryptKey,
    ciphertext
  );
  assert.deepEqual(JSON.parse(decoder.decode(opened)), { text: "E2EE test", messageId });

  const tampered = new Uint8Array(ciphertext);
  tampered[0] ^= 1;
  await assert.rejects(
    crypto.subtle.decrypt(
      { name: "AES-GCM", iv: contentIv, additionalData: contentAad },
      decryptKey,
      tampered
    ),
    "AES-GCM must reject modified ciphertext"
  );

  const attachment = encoder.encode("binary attachment fixture");
  const attachmentIv = randomBytes(12);
  const attachmentAad = encoder.encode(
    `${ALGORITHM}|attachment|v1|private-test|${messageId}|attachment-0`
  );
  const encryptedAttachment = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: attachmentIv, additionalData: attachmentAad },
    encryptKey,
    attachment
  );
  const openedAttachment = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: attachmentIv, additionalData: attachmentAad },
    decryptKey,
    encryptedAttachment
  );
  assert.deepEqual(
    new Uint8Array(openedAttachment),
    attachment,
    "the message content key must also open its authenticated attachment container"
  );

  const tamperedAttachment = new Uint8Array(encryptedAttachment);
  tamperedAttachment[tamperedAttachment.length - 1] ^= 1;
  await assert.rejects(
    crypto.subtle.decrypt(
      { name: "AES-GCM", iv: attachmentIv, additionalData: attachmentAad },
      decryptKey,
      tamperedAttachment
    ),
    "AES-GCM must reject a modified attachment container"
  );
}

async function pushPreviewRoundTrip() {
  const recipient = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const ephemeral = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const senderSigning = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"]
  );
  const recipientPublic = await rawPublic(recipient.publicKey);
  const recipientPublicEncoded = Buffer.from(recipientPublic).toString("base64url");
  const keyAttestation = encoder.encode(
    `${ALGORITHM}|push-preview-key|v1|device-recipient-test|${recipientPublicEncoded}`
  );
  const keySignature = await crypto.subtle.sign("Ed25519", senderSigning.privateKey, keyAttestation);
  assert.equal(
    await crypto.subtle.verify("Ed25519", senderSigning.publicKey, keySignature, keyAttestation),
    true,
    "the notification public key must have an identity signature"
  );

  const senderShared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: recipient.publicKey },
    ephemeral.privateKey,
    256
  ));
  const recipientShared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: ephemeral.publicKey },
    recipient.privateKey,
    256
  ));
  assert.deepEqual(senderShared, recipientShared, "push-preview ECDH must agree");

  const aad = encoder.encode(
    `${ALGORITHM}|push-preview|v1|private-test|message-test|sender|sender-device|`
    + `recipient|recipient-device|${recipientPublicEncoded}`
  );
  const salt = randomBytes(32);
  const senderMaterial = await crypto.subtle.importKey("raw", senderShared, "HKDF", false, ["deriveKey"]);
  const recipientMaterial = await crypto.subtle.importKey("raw", recipientShared, "HKDF", false, ["deriveKey"]);
  const senderKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: aad },
    senderMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const recipientKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: aad },
    recipientMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const body = encoder.encode(JSON.stringify({ version: 1, body: "реальный текст сообщения" }));
  const padded = randomBytes(1024);
  padded[0] = body.byteLength >>> 8;
  padded[1] = body.byteLength & 0xff;
  padded.set(body, 2);
  const iv = randomBytes(12);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    senderKey,
    padded
  ));
  assert.equal(ciphertext.byteLength, 1040, "push-preview ciphertext has a fixed size");

  const previewSignature = await crypto.subtle.sign(
    "Ed25519",
    senderSigning.privateKey,
    concat([aad, ciphertext])
  );
  assert.equal(
    await crypto.subtle.verify(
      "Ed25519",
      senderSigning.publicKey,
      previewSignature,
      concat([aad, ciphertext])
    ),
    true,
    "the encrypted push preview must retain sender authenticity"
  );

  const opened = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    recipientKey,
    ciphertext
  ));
  const length = (opened[0] << 8) | opened[1];
  assert.equal(
    JSON.parse(decoder.decode(opened.subarray(2, 2 + length))).body,
    "реальный текст сообщения"
  );

  const tampered = ciphertext.slice();
  tampered[0] ^= 1;
  await assert.rejects(
    crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      recipientKey,
      tampered
    ),
    "a modified encrypted push preview must fail"
  );
}

async function phase5SignedPaddedRoundTrip() {
  const signing = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const contentKeyBytes = randomBytes(32);
  const key = await crypto.subtle.importKey("raw", contentKeyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  const json = encoder.encode(JSON.stringify({
    version: 5,
    messageId: "phase5-message",
    text: "текст видят только устройства"
  }));
  const padded = randomBytes(512);
  new DataView(padded.buffer).setUint32(0, json.byteLength, false);
  padded.set(json, 4);
  const iv = randomBytes(12);
  const aad = encoder.encode(
    `${ALGORITHM}|content|v5|private-test|phase5-message|sender-device|epoch-test|attachments-encrypted`
  );
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    key,
    padded
  ));
  assert.equal(ciphertext.byteLength, 528, "phase 5 content must leak only its padding bucket");
  const signatureInput = concat([aad, iv, ciphertext]);
  const signature = await crypto.subtle.sign("Ed25519", signing.privateKey, signatureInput);
  assert.equal(
    await crypto.subtle.verify("Ed25519", signing.publicKey, signature, signatureInput),
    true,
    "phase 5 sender signature must verify"
  );
  const opened = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    key,
    ciphertext
  ));
  const length = new DataView(opened.buffer).getUint32(0, false);
  assert.equal(
    JSON.parse(decoder.decode(opened.subarray(4, 4 + length))).text,
    "текст видят только устройства"
  );
  const tampered = ciphertext.slice();
  tampered[10] ^= 1;
  assert.equal(
    await crypto.subtle.verify(
      "Ed25519",
      signing.publicKey,
      signature,
      concat([aad, iv, tampered])
    ),
    false,
    "phase 5 signature must reject a changed ciphertext"
  );
}

async function digitalIdVaultRoundTrip() {
  const owner = await x25519();
  const attacker = await x25519();
  const ephemeral = await x25519();
  const ownerShared = await dh(ephemeral.privateKey, owner.publicKey);
  const recipientShared = await dh(owner.privateKey, ephemeral.publicKey);
  assert.deepEqual(ownerShared, recipientShared, "Digital ID device envelope must derive the same key");

  const salt = randomBytes(32);
  const info = encoder.encode(`${ALGORITHM}|digital-id-envelope|v1|account-test|device-test`);
  const senderWrap = await deriveWrapKey([ownerShared], salt, info, "encrypt");
  const recipientWrap = await deriveWrapKey([recipientShared], salt, info, "decrypt");
  const contentKeyBytes = randomBytes(32);
  const iv = randomBytes(12);
  const wrapped = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: info },
    senderWrap,
    contentKeyBytes
  );
  const unwrapped = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: info },
    recipientWrap,
    wrapped
  ));
  assert.deepEqual(unwrapped, contentKeyBytes);

  const attackerShared = await dh(attacker.privateKey, ephemeral.publicKey);
  const attackerWrap = await deriveWrapKey([attackerShared], salt, info, "decrypt");
  await assert.rejects(
    crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: info },
      attackerWrap,
      wrapped
    ),
    "a database or unrelated device key must not unwrap the Digital ID key"
  );
}

await roundTrip(true);
await roundTrip(false);
await pushPreviewRoundTrip();
await phase5SignedPaddedRoundTrip();
await digitalIdVaultRoundTrip();
console.log("E2EE crypto tests passed: signed padded messages, attachments, sealed push descriptors and Digital ID vault isolation.");
