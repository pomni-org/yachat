from __future__ import annotations

import unittest

from server.message_preview import (
    ATTACHMENTS_PREVIEW,
    EMOJI_PREVIEW,
    PHOTO_PREVIEW,
    VIDEO_PREVIEW,
    is_single_emoji,
    message_preview_text,
)


class MessagePreviewTests(unittest.TestCase):
    def test_plain_text_is_shown_verbatim(self):
        self.assertEqual(message_preview_text("  обычный текст  "), "обычный текст")

    def test_exactly_one_emoji_uses_emoji_label(self):
        for value in ("😀", "❤️", "👨‍👩‍👧‍👦", "🇷🇺", "1️⃣"):
            with self.subTest(value=value):
                self.assertTrue(is_single_emoji(value))
                self.assertEqual(message_preview_text(value), EMOJI_PREVIEW)

    def test_multiple_or_mixed_emoji_stay_as_text(self):
        for value in ("😀😀", "😀 привет", "привет 😀"):
            with self.subTest(value=value):
                self.assertFalse(is_single_emoji(value))
                self.assertEqual(message_preview_text(value), value)

    def test_attachments_override_caption_text(self):
        self.assertEqual(
            message_preview_text(
                "эта подпись не должна попасть в карточку",
                [{"kind": "image", "mime": "image/jpeg"}],
            ),
            PHOTO_PREVIEW,
        )

    def test_same_media_kind_uses_specific_label(self):
        self.assertEqual(
            message_preview_text("", [{"kind": "image"}, {"kind": "image"}]),
            PHOTO_PREVIEW,
        )
        self.assertEqual(
            message_preview_text("", [{"kind": "video"}, {"mime": "video/mp4"}]),
            VIDEO_PREVIEW,
        )

    def test_mixed_or_file_attachments_use_plural_label(self):
        self.assertEqual(
            message_preview_text("", [{"kind": "image"}, {"kind": "video"}]),
            ATTACHMENTS_PREVIEW,
        )
        self.assertEqual(
            message_preview_text("", [{"kind": "file"}]),
            ATTACHMENTS_PREVIEW,
        )


if __name__ == "__main__":
    unittest.main()
