import base64
import http.client
import struct
import threading
import unittest
from unittest import mock

import render_server as server


def payload():
    glb = struct.pack('<4sII', b'glTF', 2, 20) + b'12345678'
    return dict(glb=base64.b64encode(glb).decode(), metadata=dict(
        width=2048, height=1024, quality='standard', exposure=1, hour=10,
        ceiling=2.8, night=False, rooms=[], camera=dict(
            fov=45, aspect=2, matrix=[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])))


class ValidationTests(unittest.TestCase):
    def native_payload(self):
        data = payload()
        data['metadata']['nativeFurniture'] = [dict(id='chair1', type='user_0123456789abcdef0123456789abcdef',
            colour='#6688aa', size=[.798, .9, .983], matrix=data['metadata']['camera']['matrix'].copy())]
        return data

    def test_native_furniture_validation(self):
        self.assertEqual(server.validate(self.native_payload())[0]['nativeFurniture'][0]['type'], 'user_0123456789abcdef0123456789abcdef')
        for field, value in [('type', '../../other.blend'), ('colour', 'red'), ('size', [1, 0, 1]),
                             ('size', [1, float('nan'), 1]), ('matrix', [0]*16), ('id', '')]:
            data = self.native_payload()
            data['metadata']['nativeFurniture'][0][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                server.validate(data)
        data = self.native_payload()
        data['metadata']['nativeFurniture'] *= 2
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            server.validate(data)

    def test_missing_native_master_fails_instead_of_using_glb(self):
        with mock.patch.object(server, 'source_path', return_value=server.ROOT/'not-present.blend'):
            with self.assertRaisesRegex(ValueError, 'not-present.blend'):
                server.validate(self.native_payload())

    def test_blender_override(self):
        with mock.patch.dict(server.os.environ, {'CADTOUR_BLENDER': '/custom/blender'}):
            self.assertEqual(server.find_blender(), '/custom/blender')

    def test_windows_cancel_uses_process_terminate(self):
        process = mock.Mock()
        process.poll.return_value = None
        job = {'process': process, 'cancel': False}
        with mock.patch.object(server.os, 'name', 'nt'), mock.patch.object(server.threading, 'Timer'):
            server.stop(job)
        self.assertTrue(job['cancel'])
        process.terminate.assert_called_once()

    def test_valid_container(self):
        meta, glb = server.validate(payload())
        self.assertEqual(meta['width'], 2048)
        self.assertEqual(glb[:4], b'glTF')

    def test_bad_settings(self):
        for key, value in [('width', 4096), ('height', 0), ('exposure', float('nan')),
                           ('quality', 'bogus'), ('night', 1), ('hour', float('inf'))]:
            data = payload()
            data['metadata'][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                server.validate(data)

    def test_bad_camera_and_glb(self):
        for mutate in (lambda p: p['metadata']['camera'].update(matrix=[0]),
                       lambda p: p['metadata']['camera'].update(aspect=4),
                       lambda p: p.update(glb='invalid!'),
                       lambda p: p.update(glb=base64.b64encode(b'x' * 20).decode())):
            data = payload()
            mutate(data)
            with self.assertRaises(ValueError):
                server.validate(data)

    def test_model_size_limit(self):
        data = payload()
        with mock.patch.object(server, 'MAX_MODEL', 19), self.assertRaisesRegex(ValueError, 'model size'):
            server.validate(data)
        with mock.patch.object(server, 'MAX_MODEL', 20):
            self.assertEqual(len(server.validate(data)[1]), 20)

    def test_ceiling_lights(self):
        data = payload()
        data['metadata']['lights'] = [{'center': [1, 2.765, 3], 'area': 9, 'size': .22}]
        self.assertEqual(len(server.validate(data)[0]['lights']), 1)
        for field, value in [('size', 0), ('size', float('nan')), ('area', -1), ('center', [1, 2])]:
            data = payload()
            data['metadata']['lights'] = [{'center': [1, 2, 3], 'area': 9, 'size': .22, field: value}]
            with self.subTest(field=field), self.assertRaises(ValueError):
                server.validate(data)


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.port = cls.http.server_port
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()

    def request(self, method, path, headers=None, body=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        result = (response.status, response.read())
        connection.close()
        return result

    def test_health_and_page(self):
        self.assertEqual(self.request('GET', '/')[0], 200)
        self.assertEqual(self.request('GET', '/api/cycles/health')[0], 200 if server.Path(server.BLENDER).is_file() else 503)

    def test_web_model_is_served(self):
        status, data = self.request('GET', '/assets/models/user-0123456789abcdef0123456789abcdef/model.glb')
        self.assertEqual(status, 200)
        magic, version, length = struct.unpack_from('<4sII', data)
        self.assertEqual((magic, version, length), (b'glTF', 2, len(data)))

    def test_private_artifacts_and_missing_jobs(self):
        for method in ('GET', 'HEAD'):
            self.assertEqual(self.request(method, '/.renders/metadata.json')[0], 403)
        self.assertEqual(self.request('GET', '/api/cycles/jobs/' + 'a' * 32)[0], 404)

    def test_external_sites_cannot_render(self):
        self.assertEqual(self.request('POST', '/api/cycles/jobs', body='{}')[0], 403)
        self.assertEqual(self.request('POST', '/api/cycles/jobs', headers={
            'X-CADtour': '1', 'Origin': 'https://example.com'}, body='{}')[0], 403)
        self.assertEqual(self.request('GET', '/', headers={'Host': 'example.com'})[0], 403)

    def test_invalid_upload_and_active_job(self):
        self.assertEqual(self.request('POST', '/api/cycles/jobs', headers={'X-CADtour': '1'}, body='{}')[0], 400)
        server.ACTIVE = 'test'
        try:
            self.assertEqual(self.request('POST', '/api/cycles/jobs', headers={'X-CADtour': '1'}, body='{}')[0], 409)
        finally:
            server.ACTIVE = None

    def test_oversized_request_is_rejected_before_reading(self):
        status, body = self.request('POST', '/api/cycles/jobs', headers={
            'X-CADtour': '1', 'Content-Length': str(server.MAX_BODY + 1)}, body=None)
        self.assertEqual(status, 400)
        self.assertIn(b'exceeds', body)


if __name__ == '__main__':
    unittest.main()
