from __future__ import annotations

import base64
import json
import unittest

from fastapi import HTTPException

from server.e2ee import parse_device_registration, parse_push_previews
from server.push_delivery import push_payload_for_subscription


def b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def filled(length: int, value: int) -> str:
    return b64url(bytes([value]) * length)


def p256_public(value: int) -> str:
    field = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
    x = 0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296
    y = 0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5
    if value % 2 == 0:
        y = field - y
    return b64url(bytes([4]) + x.to_bytes(32, "big") + y.to_bytes(32, "big"))


class E2EEPhase4ServerTests(unittest.TestCase):
    def registration_payload(self) -> dict[str, object]:
        return {
            "deviceId": "e2ee-device-server-phase4",
            "algorithm": "yachat-x3dh-v1",
            "protocolVersion": 4,
            "capabilities": [
                "shadow-v1",
                "server-blind-text-v1",
                "attachment-integrity-v1",
                "encrypted-attachments-v1",
                "encrypted-push-preview-v1",
            ],
            "pushPreviewPublic": p256_public(13),
            "pushPreviewSignature": filled(64, 14),
            "identityDhPublic": filled(32, 1),
            "identitySignPublic": filled(32, 2),
            "signedPreKey": {
                "id": "spk-server-phase4-test",
                "publicKey": filled(32, 3),
                "signature": filled(64, 4),
            },
            "oneTimePreKeys": [
                {"id": "opk-server-phase4-test", "publicKey": filled(32, 5)}
            ],
        }

    def push_preview(self) -> dict[str, object]:
        chat_id = "private-dddddddddddddddddddddddddddddddd"
        message_id = "44444444-4444-4444-8444-444444444444"
        sender_user_id = "sender-phase4-test"
        sender_device_id = "e2ee-device-sender-phase4"
        recipient_user_id = "recipient-phase4-test"
        recipient_device_id = "e2ee-device-recipient-phase4"
        recipient_public = p256_public(21)
        aad = (
            "yachat-x3dh-v1|push-preview|v1|"
            f"{chat_id}|{message_id}|{sender_user_id}|{sender_device_id}|"
            f"{recipient_user_id}|{recipient_device_id}|{recipient_public}"
        )
        return {
            "version": 1,
            "chatId": chat_id,
            "messageId": message_id,
            "userId": recipient_user_id,
            "deviceId": recipient_device_id,
            "senderUserId": sender_user_id,
            "senderDeviceId": sender_device_id,
            "senderIdentitySignPublic": filled(32, 22),
            "recipientPushPreviewPublic": recipient_public,
            "ephemeralKey": p256_public(23),
            "salt": filled(32, 24),
            "iv": filled(12, 25),
            "ciphertext": filled(1040, 26),
            "aad": aad,
            "signature": filled(64, 27),
        }

    def test_v4_registration_requires_signed_push_preview_key(self):
        parsed = parse_device_registration(self.registration_payload())
        self.assertEqual(parsed["protocolVersion"], 4)
        self.assertTrue(parsed["phase4Ready"])
        self.assertEqual(parsed["pushPreview"]["publicKey"], p256_public(13))

        missing_capability = self.registration_payload()
        missing_capability["capabilities"] = [
            "server-blind-text-v1",
            "encrypted-attachments-v1",
        ]
        with self.assertRaises(HTTPException):
            parse_device_registration(missing_capability)

        missing_key = self.registration_payload()
        missing_key["pushPreviewPublic"] = ""
        with self.assertRaises(HTTPException):
            parse_device_registration(missing_key)

        invalid_curve_point = self.registration_payload()
        invalid_curve_point["pushPreviewPublic"] = b64url(bytes([4]) + bytes(64))
        with self.assertRaises(HTTPException):
            parse_device_registration(invalid_curve_point)

    def test_push_preview_is_bound_to_message_device_and_recipient_key(self):
        raw = self.push_preview()
        parsed = parse_push_previews(
            [raw],
            chat_id=str(raw["chatId"]),
            message_id=str(raw["messageId"]),
            sender_device_id=str(raw["senderDeviceId"]),
        )
        self.assertEqual(len(parsed), 1)
        self.assertEqual(parsed[0]["deviceId"], raw["deviceId"])
        self.assertEqual(parsed[0]["recipientPushPreviewPublic"], raw["recipientPushPreviewPublic"])

        changed_key = self.push_preview()
        changed_key["recipientPushPreviewPublic"] = p256_public(100)
        with self.assertRaises(HTTPException):
            parse_push_previews(
                [changed_key],
                chat_id=str(changed_key["chatId"]),
                message_id=str(changed_key["messageId"]),
                sender_device_id=str(changed_key["senderDeviceId"]),
            )

        with self.assertRaises(HTTPException):
            parse_push_previews(
                [raw, raw],
                chat_id=str(raw["chatId"]),
                message_id=str(raw["messageId"]),
                sender_device_id=str(raw["senderDeviceId"]),
            )

    def test_push_delivery_routes_only_opaque_preview_for_matching_device(self):
        preview = self.push_preview()
        matching = push_payload_for_subscription(
            title="Отправитель",
            body="Новое сообщение",
            url="/sender",
            notification_tag="message:phase4",
            subscription={"device_id": preview["deviceId"]},
            encrypted_previews={str(preview["deviceId"]): preview},
        )
        matching_payload = json.loads(matching)
        self.assertLess(len(matching.encode("utf-8")), 3900)
        self.assertEqual(matching_payload["body"], "Новое сообщение")
        self.assertEqual(matching_payload["e2eePreview"]["ciphertext"], preview["ciphertext"])
        self.assertNotIn("реальный секретный текст", matching)

        other = push_payload_for_subscription(
            title="Отправитель",
            body="Новое сообщение",
            url="/sender",
            notification_tag="message:phase4",
            subscription={"device_id": "another-device-phase4"},
            encrypted_previews={str(preview["deviceId"]): preview},
        )
        self.assertNotIn("e2eePreview", json.loads(other))


if __name__ == "__main__":
    unittest.main()
