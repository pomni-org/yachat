import pathlib
import re
import unittest

from api.digital_id_blocked import format_digital_id, normalize_digital_id


MIGRATION = pathlib.Path("supabase/migrations/20260723030000_digital_id_single_script.sql")
LATIN = re.compile(r"^(?:[ABCDEFGHJKLMNPQRSTUVWXYZ]{2}\d{4}|[ABCDEFGHJKLMNPQRSTUVWXYZ]{3}\d{3})$")
CYRILLIC = re.compile(r"^(?:[АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ]{2}\d{4}|[АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ]{3}\d{3})$")


class DigitalIdMigrationTests(unittest.TestCase):
    def test_migration_selects_one_alphabet_before_generating_letters(self):
        source = MIGRATION.read_text(encoding="utf-8")
        self.assertIn("alphabet := case when random() < 0.5", source)
        self.assertIn("latin_alphabet", source)
        self.assertIn("cyrillic_alphabet", source)
        self.assertIn("public_users_digital_id_single_script_check", source)

    def test_reference_patterns_reject_mixed_scripts(self):
        self.assertTrue(LATIN.fullmatch("RKH399"))
        self.assertTrue(CYRILLIC.fullmatch("РКН399"))
        self.assertTrue(CYRILLIC.fullmatch("ЩЮЯ399"))
        self.assertFalse(LATIN.fullmatch("RКН399"))
        self.assertFalse(CYRILLIC.fullmatch("RКН399"))

    def test_server_boundary_accepts_one_script_and_rejects_mixed_letters(self):
        self.assertEqual(normalize_digital_id("RKH — 399"), "RKH399")
        self.assertEqual(normalize_digital_id("РКН — 399"), "РКН399")
        self.assertEqual(normalize_digital_id("ЩЮЯ — 399"), "ЩЮЯ399")
        self.assertEqual(normalize_digital_id("RКН — 399"), "")
        self.assertEqual(format_digital_id("РКН399"), "РКН — 399")


if __name__ == "__main__":
    unittest.main()
