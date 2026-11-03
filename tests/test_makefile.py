"""The receiver Makefile runs all its own tests without adapter machinery."""

import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


class MakefileTest(unittest.TestCase):
    def test_check_target_cannot_silently_skip_browser_tests(self):
        result = subprocess.run(["make", "--no-print-directory", "-n", "check"],
                                cwd=ROOT, check=True, capture_output=True, text=True)
        self.assertIn("node --test tests/test_viewer.cjs", result.stdout)
        self.assertIn("python3 -m unittest discover -s tests -v", result.stdout)
        self.assertNotIn("ruby", result.stdout)
        self.assertNotIn("SKIP viewer tests", result.stdout)

    def test_install_targets_live_in_adapter_repository(self):
        makefile = (ROOT / "Makefile").read_text()
        self.assertNotIn("install-local", makefile)
        self.assertNotIn("gps_streamer", makefile)
        self.assertNotIn("MSF_DIR", makefile)


if __name__ == "__main__":
    unittest.main()
