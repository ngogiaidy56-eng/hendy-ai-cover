import unittest
from worker.core import INDEX_KEY_RE, MODEL_KEY_RE, validate_voice_entry, safe_relative_key


class VoiceCatalogTests(unittest.TestCase):
    def setUp(self):
        self.voice = {
            "id": "licensed-voice-01",
            "name": "Licensed preset",
            "enabled": True,
            "model_key": "models/voices/voice.pth",
            "rights": {
                "voice_owner_consent": True,
                "rights_holder": "Rights holder",
                "license": "Written license",
                "authorization_reference": "LIC-001",
            },
        }

    def test_accepts_preset_with_rights_record(self):
        self.assertTrue(validate_voice_entry(self.voice))

    def test_rejects_missing_consent(self):
        self.voice["rights"]["voice_owner_consent"] = False
        self.assertFalse(validate_voice_entry(self.voice))

    def test_rejects_path_traversal(self):
        self.voice["model_key"] = "models/voices/../private.pth"
        self.assertFalse(validate_voice_entry(self.voice))

    def test_key_patterns(self):
        self.assertTrue(safe_relative_key("models/voices/voice.pth", MODEL_KEY_RE))
        self.assertTrue(safe_relative_key("models/voices/voice.index", INDEX_KEY_RE))
        self.assertFalse(safe_relative_key("models/voices/../../voice.pth", MODEL_KEY_RE))


if __name__ == "__main__":
    unittest.main()
