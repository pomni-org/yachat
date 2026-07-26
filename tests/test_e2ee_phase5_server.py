from __future__ import annotations

import base64
import pathlib
import unittest
from unittest.mock import patch

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import HTTPException

from api.message import encrypted_previews_for_user
from server.digital_id_vault import (
    digital_id_envelope_digest,
    digital_id_lookup_hash,
    digital_id_signature_input,
    parse_digital_id_vault,
)
from server.e2ee import (
    envelope_digest,
    message_signature_input,
    parse_device_registration,
    parse_e2ee_message,
    parse_push_previews,
    verify_ed25519,
)
from server.push_delivery import push_payload_for_subscription


def b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def filled(length: int, value: int) -> str:
    return b64url(bytes([value]) * length)


def p256_public() -> str:
    x = 0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296
    y = 0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5
    return b64url(bytes([4]) + x.to_bytes(32, "big") + y.to_bytes(32, "big"))


class E2EEPhase5ServerTests(unittest.TestCase):
    def setUp(self):
        self.signing_private = Ed25519PrivateKey.generate()
        self.signing_public = b64url(
            self.signing_private.public_key().public_bytes(
                serialization.Encoding.Raw,
                serialization.PublicFormat.Raw,
            )
        )

    def registration_payload(self) -> dict[str, object]:
        device_id = "e2ee-device-server-phase5"
        identity_dh_public = filled(32, 1)
        signed_prekey = filled(32, 3)
        push_public = p256_public()
        return {
            "deviceId": device_id,
            "algorithm": "yachat-x3dh-v1",
            "protocolVersion": 5,
            "capabilities": [
                "shadow-v1",
                "server-blind-text-v1",
                "attachment-integrity-v1",
                "encrypted-attachments-v1",
                "encrypted-push-preview-v1",
                "mandatory-e2ee-v1",
                "signed-messages-v1",
                "padded-content-v1",
                "sealed-push-descriptor-v1",
                "encrypted-digital-id-v1",
            ],
            "pushPreviewPublic": push_public,
            "pushPreviewSignature": b64url(
                self.signing_private.sign(
                    (
                        "yachat-x3dh-v1|push-preview-key|v1|"
                        f"{device_id}|{push_public}"
                    ).encode()
                )
            ),
            "identityDhPublic": identity_dh_public,
            "identityDhSignature": b64url(
                self.signing_private.sign(
                    (
                        "yachat-x3dh-v1|identity-dh-key|v1|"
                        f"{device_id}|{identity_dh_public}"
                    ).encode()
                )
            ),
            "identitySignPublic": self.signing_public,
            "signedPreKey": {
                "id": "spk-server-phase5-test",
                "publicKey": signed_prekey,
                "signature": b64url(
                    self.signing_private.sign(base64.urlsafe_b64decode(signed_prekey + "=="))
                ),
            },
            "oneTimePreKeys": [
                {"id": "opk-server-phase5-test", "publicKey": filled(32, 5)}
            ],
        }

    def encrypted_message(self) -> dict[str, object]:
        chat_id = "private-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
        message_id = "55555555-5555-4555-8555-555555555555"
        device_id = "e2ee-device-server-phase5"
        epoch_id = "epoch-server-phase5-test"
        envelopes = [
            {
                "deviceId": device_id,
                "userId": "user-server-phase5-test",
                "signedPreKeyId": "spk-server-phase5-test",
                "oneTimePreKeyId": "",
                "senderIdentityKey": filled(32, 1),
                "ephemeralKey": filled(32, 9),
                "salt": filled(32, 10),
                "iv": filled(12, 11),
                "ciphertext": filled(48, 12),
            }
        ]
        raw: dict[str, object] = {
            "version": 5,
            "mode": "encrypted",
            "attachmentMode": "encrypted",
            "paddingScheme": "bucket-v1",
            "chatId": chat_id,
            "messageId": message_id,
            "senderDeviceId": device_id,
            "senderIdentitySignPublic": self.signing_public,
            "epochId": epoch_id,
            "ciphertext": filled(528, 6),
            "iv": filled(12, 7),
            "aad": (
                "yachat-x3dh-v1|content|v5|"
                f"{chat_id}|{message_id}|{device_id}|{epoch_id}|attachments-encrypted"
            ),
            "plaintextDigest": filled(32, 8),
            "envelopes": envelopes,
            "envelopeDigest": envelope_digest(envelopes),
        }
        raw["signature"] = b64url(
            self.signing_private.sign(
                (
                    "yachat-x3dh-v1|message-signature|v1|"
                    f"{raw['aad']}|{raw['iv']}|{raw['ciphertext']}|"
                    f"{raw['plaintextDigest']}|{raw['envelopeDigest']}"
                ).encode()
            )
        )
        return raw

    def digital_id_vault(self, user_id: str) -> dict[str, object]:
        envelopes = [
            {
                "deviceId": "e2ee-device-server-phase5",
                "recipientIdentityKey": filled(32, 1),
                "recipientIdentitySignPublic": self.signing_public,
                "recipientIdentityDhSignature": b64url(
                    self.signing_private.sign(
                        (
                            "yachat-x3dh-v1|identity-dh-key|v1|"
                            "e2ee-device-server-phase5|"
                            f"{filled(32, 1)}"
                        ).encode()
                    )
                ),
                "ephemeralKey": filled(32, 21),
                "salt": filled(32, 22),
                "iv": filled(12, 23),
                "ciphertext": filled(48, 24),
            }
        ]
        vault: dict[str, object] = {
            "version": 1,
            "algorithm": "yachat-x3dh-v1",
            "ciphertext": filled(272, 25),
            "iv": filled(12, 26),
            "aad": f"yachat-x3dh-v1|digital-id|v1|{user_id}",
            "envelopes": envelopes,
            "plaintextDigest": filled(32, 27),
            "senderDeviceId": "e2ee-device-server-phase5",
            "senderIdentitySignPublic": self.signing_public,
            "envelopeDigest": digital_id_envelope_digest(envelopes),
        }
        vault["signature"] = b64url(
            self.signing_private.sign(digital_id_signature_input(vault))
        )
        return vault

    def test_v5_registration_cryptographically_verifies_key_attestations(self):
        parsed = parse_device_registration(self.registration_payload())
        self.assertTrue(parsed["phase5Ready"])

        tampered = self.registration_payload()
        tampered["signedPreKey"] = {
            **tampered["signedPreKey"],
            "publicKey": filled(32, 99),
        }
        with self.assertRaises(HTTPException):
            parse_device_registration(tampered)

        tampered_identity = self.registration_payload()
        tampered_identity["identityDhPublic"] = filled(32, 98)
        with self.assertRaises(HTTPException):
            parse_device_registration(tampered_identity)

    def test_v5_message_requires_padding_digest_and_sender_signature(self):
        raw = self.encrypted_message()
        parsed = parse_e2ee_message(
            raw,
            chat_id=str(raw["chatId"]),
            message_id=str(raw["messageId"]),
        )
        verify_ed25519(
            parsed["senderIdentitySignPublic"],
            parsed["signature"],
            message_signature_input(parsed),
            field="message",
        )
        self.assertEqual(parsed["paddingScheme"], "bucket-v1")

        tampered = self.encrypted_message()
        tampered["ciphertext"] = filled(528, 88)
        parsed_tampered = parse_e2ee_message(
            tampered,
            chat_id=str(tampered["chatId"]),
            message_id=str(tampered["messageId"]),
        )
        with self.assertRaises(HTTPException):
            verify_ed25519(
                parsed_tampered["senderIdentitySignPublic"],
                parsed_tampered["signature"],
                message_signature_input(parsed_tampered),
                field="message",
            )

    def test_digital_id_vault_has_no_plaintext_and_is_signed(self):
        user_id = "user-server-phase5-test"
        vault = self.digital_id_vault(user_id)
        parsed = parse_digital_id_vault(vault, user_id=user_id)
        verify_ed25519(
            parsed["senderIdentitySignPublic"],
            parsed["signature"],
            digital_id_signature_input(parsed),
            field="Digital ID vault",
        )
        self.assertNotIn("РКН399", str(vault))

    def test_digital_id_lookup_requires_a_non_database_server_secret(self):
        with patch.dict(
            "os.environ",
            {"YACHAT_DIGITAL_ID_HMAC_SECRET": "h" * 32},
            clear=True,
        ):
            self.assertEqual(
                digital_id_lookup_hash("ркн399"),
                digital_id_lookup_hash("РКН399"),
            )
        with patch.dict("os.environ", {}, clear=True):
            with self.assertRaises(HTTPException):
                digital_id_lookup_hash("РКН399")

    def test_phase5_push_outer_payload_is_generic(self):
        device_id = "e2ee-device-server-phase5"
        preview = {
            "version": 2,
            "ciphertext": filled(1040, 30),
            "contextId": filled(32, 29),
        }
        payload = push_payload_for_subscription(
            title="ЯЧат",
            body="Новое сообщение",
            url="/web",
            notification_tag="e2ee:opaque",
            subscription={"device_id": device_id},
            encrypted_previews={device_id: preview},
        )
        self.assertNotIn("sender", payload.lower())
        self.assertNotIn("private-", payload)
        self.assertNotIn("deviceId", payload)
        self.assertIn('"e2eePreview"', payload)

    def test_sealed_push_descriptor_rejects_route_metadata(self):
        context_id = filled(32, 31)
        recipient_public = p256_public()
        sender_device = "e2ee-device-sender-phase5"
        recipient_device = "e2ee-device-server-phase5"
        aad = f"yachat-x3dh-v1|push-descriptor|v2|{context_id}"
        preview = {
            "version": 2,
            "contextId": context_id,
            "deviceId": recipient_device,
            "senderDeviceId": sender_device,
            "senderIdentitySignPublic": self.signing_public,
            "recipientPushPreviewPublic": recipient_public,
            "ephemeralKey": p256_public(),
            "salt": filled(32, 32),
            "iv": filled(12, 33),
            "ciphertext": filled(1040, 34),
            "aad": aad,
            "signature": filled(64, 35),
        }
        parsed = parse_push_previews(
            [preview],
            chat_id="private-not-in-envelope",
            message_id="message-not-in-envelope",
            sender_device_id=sender_device,
        )
        self.assertEqual(parsed[0]["contextId"], context_id)
        self.assertEqual(parsed[0]["chatId"], "")
        self.assertEqual(parsed[0]["userId"], "")
        parsed[0]["_recipientUserId"] = "recipient-user"
        transport = encrypted_previews_for_user(
            {"pushPreviews": parsed},
            "recipient-user",
        )[recipient_device]
        self.assertNotIn("deviceId", transport)
        self.assertNotIn("senderDeviceId", transport)
        self.assertNotIn("recipientPushPreviewPublic", transport)
        self.assertNotIn("senderIdentitySignPublic", transport)
        self.assertNotIn("signature", transport)
        self.assertNotIn(sender_device, transport["aad"])
        self.assertNotIn(recipient_device, transport["aad"])

        leaked = {**preview, "chatId": "private-leaked"}
        with self.assertRaises(HTTPException):
            parse_push_previews(
                [leaked],
                chat_id="private-leaked",
                message_id="message-leaked",
                sender_device_id=sender_device,
            )

    def test_cutover_migrations_are_fail_closed(self):
        root = pathlib.Path("supabase/migrations")
        activation = (root / "20260726081000_e2ee_phase5_require_existing_accounts.sql").read_text()
        cutover = (root / "20260726082000_digital_id_ciphertext_cutover.sql").read_text()
        self.assertIn("e2ee_min_protocol = greatest(e2ee_min_protocol, 5)", activation)
        self.assertIn("set e2ee_capable_at = null", activation)
        self.assertIn("expires_at = least(expires_at, now())", activation)
        self.assertIn("alter column digital_id drop not null", cutover)
        self.assertIn("drop column if exists digital_id", cutover)
        self.assertIn("drop trigger if exists public_users_digital_id_immutable", cutover)
        foundation = (root / "20260726080000_e2ee_phase5_foundation.sql").read_text()
        self.assertIn("identity_dh_signature", foundation)
        self.assertIn("used_by_message_id", foundation)


if __name__ == "__main__":
    unittest.main()
