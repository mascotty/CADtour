"""Exercise real Windows font outlines and the restricted local HTTP endpoint."""
import json
import os
import unittest

import test_render_server as render_tests
from wall_text_outlines import text_outlines


@unittest.skipUnless(os.name == 'nt', 'The local font provider uses Windows GDI')
class OutlineTests(unittest.TestCase):
    def test_chinese_counters_and_fonts(self):
        variations = []
        for font in ['yahei', 'hei', 'song']:
            data = text_outlines(font, '回口O8 诊室\nDENTAL')
            self.assertEqual(data['font'], font)
            self.assertEqual(data['resolution'], 1000)
            for char in '回口O':
                self.assertGreaterEqual(len(data['glyphs'][char]['paths']), 2)
            self.assertGreaterEqual(len(data['glyphs']['8']['paths']), 3)
            self.assertEqual(data['glyphs'][' ']['paths'], [])
            variations.append(json.dumps(data['glyphs']['回']))
        self.assertEqual(len(set(variations)), 3)

    def test_invalid_text_and_font(self):
        for font, text in [('other', 'Text'), ('../../font', 'Text'), ('hei', ''), ('hei', ' '),
                           ('hei', '🦷'), ('hei', 'a'*121), ('hei', '\n'*11+'X'), ('hei', '\x00')]:
            with self.subTest(font=font, text=text), self.assertRaises(ValueError):
                text_outlines(font, text)


class FontHTTPTests(render_tests.HTTPTests):
    def test_font_requests_are_local_and_bounded(self):
        path = '/api/wall-text/outlines'
        self.assertEqual(self.request('POST', path, body='{}')[0], 403)
        self.assertEqual(self.request('POST', path, headers={'X-CADtour': '1', 'Origin': 'https://example.com'}, body='{}')[0], 403)
        self.assertEqual(self.request('POST', path, headers={'X-CADtour': '1', 'Content-Length': '8193'}, body=None)[0], 400)
        self.assertEqual(self.request('POST', path, headers={'X-CADtour': '1'}, body='[]')[0], 400)
        self.assertEqual(self.request('POST', path, headers={'X-CADtour': '1'}, body='{"font":"../../x","text":"X"}')[0], 400)

    @unittest.skipUnless(os.name == 'nt', 'The local font provider uses Windows GDI')
    def test_real_font_response_during_render(self):
        import render_server
        render_server.ACTIVE = 'in-progress-test'
        try:
            status, body = self.request('POST', '/api/wall-text/outlines', headers={'X-CADtour': '1'}, body=json.dumps({'font': 'hei', 'text': '回 O8'}))
            self.assertEqual(status, 200)
            self.assertEqual(len(json.loads(body)['glyphs']['O']['paths']), 2)
        finally:
            render_server.ACTIVE = None


if __name__ == '__main__':
    unittest.main()
