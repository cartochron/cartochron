"""A completed verified Leaflet install should not need network on demo launch."""
import base64
import hashlib
import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

import vendor_leaflet


class VendorOfflineTest(TestCase):
    def test_existing_verified_assets_are_reused_without_fetching(self):
        with tempfile.TemporaryDirectory() as directory:
            dest = Path(directory)
            # Patch the declared digests for a small fake fixture; do not
            # weaken or replace the production pinning requirements.
            files = {rel: b'fixture:' + rel.encode() for rel in vendor_leaflet.FILES}
            for rel, data in files.items():
                file = dest / rel.removeprefix('dist/')
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(data)
            hashes = {name: base64.b64encode(hashlib.sha256(files['dist/' + name]).digest()).decode()
                      for name in ('leaflet.js', 'leaflet.css')}
            with patch.object(vendor_leaflet, 'DEST', dest), \
                 patch.object(vendor_leaflet, 'EXPECTED_SHA256', hashes), \
                 patch.object(vendor_leaflet, 'urlopen') as network:
                self.assertTrue(vendor_leaflet.installed_and_verified())
                vendor_leaflet.main()
                network.assert_not_called()
                (dest / 'leaflet.js').write_bytes(b'modified')
                self.assertFalse(vendor_leaflet.installed_and_verified())
