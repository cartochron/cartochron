"""The documented Make targets must respect operator paths and run every suite."""

import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
MODULE = Path("post/android/gather/gps_streamer.rb")


class MakefileTest(unittest.TestCase):
    def test_install_and_uninstall_honor_custom_msf_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            modules = Path(directory) / "alternate modules"
            args = [f"MSF_DIR={modules}"]
            subprocess.run(["make", "--no-print-directory", "install-local", *args],
                           cwd=ROOT, check=True, capture_output=True, text=True)
            installed = modules / MODULE
            self.assertEqual(installed.read_bytes(), (ROOT / "gps_streamer.rb").read_bytes())
            subprocess.run(["make", "--no-print-directory", "uninstall-local", *args],
                           cwd=ROOT, check=True, capture_output=True, text=True)
            self.assertFalse(installed.exists())

    def test_check_target_cannot_silently_skip_browser_tests(self):
        result = subprocess.run(["make", "--no-print-directory", "-n", "check"],
                                cwd=ROOT, check=True, capture_output=True, text=True)
        self.assertIn("node --test tests/test_viewer.cjs", result.stdout)
        self.assertNotIn("SKIP viewer tests", result.stdout)


if __name__ == "__main__":
    unittest.main()
