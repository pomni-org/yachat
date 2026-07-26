from __future__ import annotations

import base64
import unittest

from fastapi import HTTPException

from api.message import validate_encrypted_attachment_transport
from server.e2ee import parse_device_registration, parse_e2ee_message


def b64url(length: int, fill: int) -> str:
    return base64.urlsafe_b64encode(bytes([fill]) * length).decode("ascii").rstrip("=")


class E2EEPhase3ServerTests(unittest.TestCase):
    def registration_payload(self) -> dict[str, object]:
        return {
            "deviceId": "e2ee-device-server-phase3",
            "algorithm": "yachat-x3dh-v1",
            "protocolVersion": 3,
            "capabilities": [
                "shadow-v1",
                "server-blind-text-v1",
                "attachment-integrity-v1",
                "encrypted-attachments-v1",
            ],
            "identityDhPublic": b64url(32, 1),
            "identitySignPublic": b64url(32, 2),
            "signedPreKey": {
                "id": "spk-server-phase3-test",
                "publicKey": b64url(32, 3),
                "signature": b64url(64, 4),
            },
            "oneTimePreKeys": [
                {"id": "opk-server-phase3-test", "publicKey": b64url(32, 5)}
            ],
        }

    def encrypted_payload(self) -> dict[str, object]:
        chat_id = "private-cccccccccccccccccccccccccccccccc"
        message_id = "33333333-3333-4333-8333-333333333333"
        device_id = "e2ee-device-server-phase3"
        epoch_id = "epoch-server-phase3-test"
        return {
            "version": 3,
            "mode": "encrypted",
            "attachmentMode": "encrypted",
            "chatId": chat_id,
            "messageId": message_id,
            "senderDeviceId": device_id,
            "epochId": epoch_id,
            "ciphertext": b64url(48, 6),
            "iv": b64url(12, 7),
            "aad": (
                "yachat-x3dh-v1|content|v3|"
                f"{chat_id}|{message_id}|{device_id}|{epoch_id}|attachments-encrypted"
            ),
            "plaintextDigest": b64url(32, 8),
            "envelopes": [
                {
                    "deviceId": device_id,
                    "userId": "user-server-phase3-test",
                    "signedPreKeyId": "spk-server-phase3-test",
                    "oneTimePreKeyId": "",
                    "senderIdentityKey": b64url(32, 1),
                    "ephemeralKey": b64url(32, 9),
                    "salt": b64url(32, 10),
                    "iv": b64url(12, 11),
                    "ciphertext": b64url(48, 12),
                }
            ],
        }

    def test_v3_registration_requires_encrypted_attachment_capability(self):
        parsed = parse_device_registration(self.registration_payload())
        self.assertEqual(parsed["protocolVersion"], 3)
        self.assertTrue(parsed["phase2Ready"])
        self.assertTrue(parsed["phase3Ready"])

        missing = self.registration_payload()
        missing["capabilities"] = ["shadow-v1", "server-blind-text-v1"]
        with self.assertRaises(HTTPException) as raised:
            parse_device_registration(missing)
        self.assertEqual(raised.exception.status_code, 400)

    def test_v3_attachment_mode_is_bound_to_content_aad(self):
        raw = self.encrypted_payload()
        parsed = parse_e2ee_message(
            raw,
            chat_id=str(raw["chatId"]),
            message_id=str(raw["messageId"]),
        )
        self.assertEqual(parsed["version"], 3)
        self.assertEqual(parsed["attachmentMode"], "encrypted")

        downgraded = self.encrypted_payload()
        downgraded["attachmentMode"] = "plaintext"
        with self.assertRaises(HTTPException) as raised:
            parse_e2ee_message(
                downgraded,
                chat_id=str(downgraded["chatId"]),
                message_id=str(downgraded["messageId"]),
            )
        self.assertEqual(raised.exception.status_code, 400)

        v2_claim = self.encrypted_payload()
        v2_claim["version"] = 2
        with self.assertRaises(HTTPException) as raised:
            parse_e2ee_message(
                v2_claim,
                chat_id=str(v2_claim["chatId"]),
                message_id=str(v2_claim["messageId"]),
            )
        self.assertEqual(raised.exception.status_code, 400)

    def test_encrypted_attachment_transport_rejects_plaintext_or_duplicates(self):
        encrypted = {"version": 3, "attachmentMode": "encrypted"}
        valid = [
            {
                "id": "attachment-phase3-test",
                "name": "encrypted",
                "mime": "application/vnd.yachat.e2ee",
                "kind": "file",
                "size": 48,
                "dataUrl": "data:application/vnd.yachat.e2ee;base64,QUJDRA==",
            }
        ]
        validate_encrypted_attachment_transport(valid, encrypted)

        plaintext = [{**valid[0], "dataUrl": "data:text/plain;base64,0J/RgNC40LLQtdGC"}]
        with self.assertRaises(HTTPException):
            validate_encrypted_attachment_transport(plaintext, encrypted)

        with self.assertRaises(HTTPException):
            validate_encrypted_attachment_transport([valid[0], valid[0]], encrypted)


if __name__ == "__main__":
    unittest.main()
