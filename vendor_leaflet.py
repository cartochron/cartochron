#!/usr/bin/env python3
"""Install a pinned, integrity-checked local Leaflet 1.9.4 distribution."""

import base64
import hashlib
import io
import tarfile
from pathlib import Path
from urllib.request import Request, urlopen

VERSION = "1.9.4"
URL = f"https://registry.npmjs.org/leaflet/-/leaflet-{VERSION}.tgz"
# Integrity advertised in npm's metadata for leaflet@1.9.4.
EXPECTED_TARBALL_SHA512 = (
    "nxS1ynzJOmOlHp+iL3FyWqK89GtNL8U8rvlMOsQdTTssxZwCXh8N2NB3GDQOL+"
    "YR3XnWyZAxwQixURb+FA74PA=="
)
EXPECTED_SHA256 = {
    "leaflet.js": "20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=",
    "leaflet.css": "p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=",
}
FILES = (
    "dist/leaflet.css",
    "dist/leaflet.js",
    "dist/images/layers.png",
    "dist/images/layers-2x.png",
    "dist/images/marker-icon.png",
    "dist/images/marker-icon-2x.png",
    "dist/images/marker-shadow.png",
    "LICENSE",
)
DEST = Path(__file__).resolve().parent / "vendor" / "leaflet"


def installed_and_verified():
    """Reuse an intact local vendor tree without requiring Internet access."""
    if not all((DEST / (rel.removeprefix("dist/") if rel.startswith("dist/") else rel)).is_file()
               for rel in FILES):
        return False
    return all(base64.b64encode(hashlib.sha256((DEST / name).read_bytes()).digest()).decode()
               == expected for name, expected in EXPECTED_SHA256.items())


def main():
    if installed_and_verified():
        print(f"Leaflet {VERSION} is already installed and verified in {DEST}")
        return
    print(f"Fetching Leaflet {VERSION} from npm ...", flush=True)
    req = Request(URL, headers={"User-Agent": "GPSMapLab-vendor/1.0"})
    with urlopen(req, timeout=30) as response:
        blob = response.read(12 * 1024 * 1024 + 1)
    if len(blob) > 12 * 1024 * 1024:
        raise RuntimeError("Leaflet archive exceeds size limit")
    actual = base64.b64encode(hashlib.sha512(blob).digest()).decode()
    if actual != EXPECTED_TARBALL_SHA512:
        raise RuntimeError("Leaflet archive integrity mismatch; nothing installed")

    contents = {}
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as archive:
        for rel in FILES:
            member = archive.getmember("package/" + rel)
            if not member.isfile() or member.size > 2 * 1024 * 1024:
                raise RuntimeError("Unexpected archive entry: " + rel)
            contents[rel] = archive.extractfile(member).read()
    for name, expected in EXPECTED_SHA256.items():
        actual = base64.b64encode(hashlib.sha256(contents["dist/" + name]).digest()).decode()
        if actual != expected:
            raise RuntimeError("Unexpected Leaflet " + name + " digest")

    # All archive content is validated before any file is written.
    for rel, data in contents.items():
        destination = DEST / (rel.removeprefix("dist/") if rel.startswith("dist/") else rel)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    print(f"Installed {VERSION} to {DEST} ({len(contents)} files)")


if __name__ == "__main__":
    main()
