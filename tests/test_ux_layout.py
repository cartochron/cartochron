"""Guard the map-first presentation without coupling to a browser renderer."""
from html.parser import HTMLParser
from pathlib import Path
import unittest


class Structure(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parents = []
        self.owners = {}

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if attrs.get('id'):
            self.owners.setdefault(attrs['id'], []).append(tuple(self.parents))
        if tag not in {'meta', 'link', 'img', 'input', 'br', 'hr'}:
            self.parents.append((tag, attrs.get('id') or ('map-stage' if 'map-stage' in attrs.get('class', '').split() else None)))

    def handle_endtag(self, tag):
        if tag not in {'meta', 'link', 'img', 'input', 'br', 'hr'}:
            self.assert_current = self.parents.pop()
            if self.assert_current[0] != tag:
                raise ValueError(f"unbalanced {tag}")


class LayoutTest(unittest.TestCase):
    def test_investigation_panels_float_over_the_map_and_are_unique(self):
        html = (Path(__file__).resolve().parent.parent / 'index.html').read_text()
        layout = Structure()
        layout.feed(html)
        self.assertFalse(layout.parents, 'unclosed HTML containers')
        for name in ('map', 'analysis-drawer', 'layers-panel', 'place-panel', 'proximity-panel',
                     'drawer-close', 'history-actions', 'history-controls'):
            self.assertEqual(len(layout.owners.get(name, [])), 1, name)
        for panel in ('layers-panel', 'place-panel', 'proximity-panel'):
            self.assertIn(('aside', 'analysis-drawer'), layout.owners[panel][0])
            self.assertNotIn(('header', None), layout.owners[panel][0])
        self.assertIn(('div', 'map-stage'), layout.owners['analysis-drawer'][0])
        self.assertIn(('div', 'map-stage'), layout.owners['map'][0])
        self.assertIn('position:absolute', html)
        self.assertIn('overscroll-behavior:contain', html)

    def test_map_controls_cannot_cover_header_popovers(self):
        """Keep Leaflet's z-index:1000 controls inside the map stacking context.

        Without isolation, a zoom button can cover the History time picker
        even though that picker belongs to the higher-level header.
        """
        html = (Path(__file__).resolve().parent.parent / 'index.html').read_text()
        self.assertRegex(html, r'\.map-stage\s*\{[^}]*\bisolation:isolate;')


if __name__ == '__main__':
    unittest.main()
