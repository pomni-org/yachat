from __future__ import annotations

import base64
import unittest

from fastapi import HTTPException

from server.e2ee import (
    canonical_roster,
    e2ee_message_columns,
    parse_device_registration,
    parse_e2ee_message,
    roster_digest,
)


def b64url(length: int, fill: int) -> str:
    return base64.urlsafe_b64encode(bytes([fill]) * length).decode("ascii").rstrip("=")


class E2EEPhase2ServerTests(unittest.TestCase):
    def registration_payload(self) -> dict[str, object]:
        return {
            "deviceId": "e2ee-device-server-test",
            "algorithm": "yachat-x3dh-v1",
            "protocolVersion": 2,
            "capabilities": ["shadow-v1", "server-blind-text-v1", "attachment-integrity-v1"],
            "identityDhPublic": b64url(32, 1),
            "identitySignPublic": b64url(32, 2),
            "signedPreKey": {
                "id": "spk-server-phase2-test",
                "publicKey": b64url(32, 3),
                "signature": b64url(64, 4),
            },
            "oneTimePreKeys": [
                {"id": "opk-server-phase2-test", "publicKey": b64url(32, 5)}
            ],
        }

    def encrypted_payload(self) -> dict[str, object]:
        chat_id = "private-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        message_id = "11111111-1111-4111-8111-111111111111"
        device_id = "e2ee-device-server-test"
        epoch_id = "epoch-server-phase2-test"
        return {
            "version": 2,
            "mode": "encrypted",
            "chatId": chat_id,
            "messageId": message_id,
            "senderDeviceId": device_id,
            "epochId": epoch_id,
            "ciphertext": b64url(48, 6),
            "iv": b64url(12, 7),
            "aad": (
                "yachat-x3dh-v1|content|v2|"
                f"{chat_id}|{message_id}|{device_id}|{epoch_id}"
            ),
            "plaintextDigest": b64url(32, 8),
            "envelopes": [
                {
                    "deviceId": device_id,
                    "userId": "user-server-phase2-test",
                    "signedPreKeyId": "spk-server-phase2-test",
                    "oneTimePreKeyId": "",
                    "senderIdentityKey": b64url(32, 1),
                    "ephemeralKey": b64url(32, 9),
                    "salt": b64url(32, 10),
                    "iv": b64url(12, 11),
                    "ciphertext": b64url(48, 12),
                }
            ],
        }

    def test_v2_registration_requires_server_blind_capability(self):
        parsed = parse_device_registration(self.registration_payload())
        self.assertEqual(parsed["protocolVersion"], 2)
        self.assertTrue(parsed["phase2Ready"])
        self.assertIn("server-blind-text-v1", parsed["capabilities"])

        missing = self.registration_payload()
        missing["capabilities"] = ["shadow-v1"]
        with self.assertRaises(HTTPException) as raised:
            parse_device_registration(missing)
        self.assertEqual(raised.exception.status_code, 400)

    def test_encrypted_payload_is_bound_to_exact_context(self):
        raw = self.encrypted_payload()
        parsed = parse_e2ee_message(
            raw,
            chat_id=str(raw["chatId"]),
            message_id=str(raw["messageId"]),
        )
        self.assertEqual(parsed["version"], 2)
        self.assertEqual(parsed["mode"], "encrypted")
        self.assertEqual(parsed["epochId"], "epoch-server-phase2-test")
        self.assertEqual(len(parsed["envelopes"]), 1)

        wrong = self.encrypted_payload()
        wrong["aad"] = str(wrong["aad"]).replace("epoch-server-phase2-test", "epoch-attacker-phase2")
        with self.assertRaises(HTTPException) as raised:
            parse_e2ee_message(
                wrong,
                chat_id=str(wrong["chatId"]),
                message_id=str(wrong["messageId"]),
            )
        self.assertEqual(raised.exception.status_code, 400)

    def test_phase1_shadow_aad_remains_readable(self):
        chat_id = "private-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        message_id = "22222222-2222-4222-8222-222222222222"
        device_id = "e2ee-device-phase1-test"
        raw = self.encrypted_payload()
        raw.update({
            "version": 1,
            "mode": "shadow",
            "chatId": chat_id,
            "messageId": message_id,
            "senderDeviceId": device_id,
            "epochId": "",
            "aad": f"yachat-x3dh-v1|content|{chat_id}|{message_id}|{device_id}",
        })
        raw["envelopes"][0]["deviceId"] = device_id
        parsed = parse_e2ee_message(raw, chat_id=chat_id, message_id=message_id)
        self.assertEqual(parsed["version"], 1)
        self.assertEqual(parsed["mode"], "shadow")
        self.assertEqual(parsed["epochId"], "")
        columns = e2ee_message_columns(parsed)
        self.assertIsNone(columns[8])

    def test_roster_hash_is_canonical_and_user_bound(self):
        left = canonical_roster([
            {"device_id": "device-b", "user_id": "user-2"},
            {"device_id": "device-a", "user_id": "user-1"},
        ])
        right = canonical_roster([
            {"deviceId": "device-a", "userId": "user-1"},
            {"deviceId": "device-b", "userId": "user-2"},
        ])
        self.assertEqual(left, right)
        self.assertEqual(roster_digest(left), roster_digest(right))
        self.assertNotEqual(
            roster_digest(left),
            roster_digest([
                {"deviceId": "device-a", "userId": "user-2"},
                {"deviceId": "device-b", "userId": "user-1"},
            ]),
        )


if __name__ == "__main__":
    unittest.main()
