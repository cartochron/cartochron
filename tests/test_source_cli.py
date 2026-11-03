"""CLI enrollment uses the same persistent database as the HTTP server."""

from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class SourceCLITest(unittest.TestCase):
    def test_enroll_and_list(self):
        with tempfile.TemporaryDirectory() as directory:
            db = str(Path(directory) / 'history.sqlite3')
            command = [sys.executable, 'sources.py', '--db', db]
            enrolled = subprocess.run(command + ['add', 'Test GPS receiver'],
                                      capture_output=True, text=True, check=True)
            source_id = enrolled.stdout.strip()
            self.assertRegex(source_id, r'\Asrc_[a-f0-9]{24}\Z')
            listed = subprocess.run(command + ['list'], capture_output=True,
                                    text=True, check=True)
            self.assertIn(source_id + '\tTest GPS receiver', listed.stdout)
            self.assertEqual(Path(db).stat().st_mode & 0o777, 0o600)


if __name__ == '__main__':
    unittest.main()
