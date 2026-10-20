import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import zipfile

import asset_catalog
import asset_import
import test_render_server as render_tests


class ArchiveTests(unittest.TestCase):
    def test_atomic_publication_and_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            models=root/'models'
            models.mkdir()
            staging=root/'jobs'
            identifier='b'*32
            output=staging/identifier/'output'
            uploads=staging/identifier/'uploads'
            output.mkdir(parents=True)
            uploads.mkdir()
            for filename in ['source.blend','model.glb','preview.png']:
                (output/filename).write_bytes(b'test output')
            (uploads/'original.fbx').write_bytes(b'original')
            job=dict(id=identifier,state='ready',name='Test',category='Tests',yaw=0,files=['original.fbx'],manifest=dict(width=1,height=2,depth=3,sourcePolygons=12,webPolygons=12,warnings=[]))
            with mock.patch.object(asset_import,'STAGING',staging),mock.patch.object(asset_import,'MODELS',models),mock.patch.object(asset_catalog,'CATALOG',models/'catalog.json'):
                item=asset_import.publish(job,dict(name='Chair',category='Furniture',yaw=0,widthMm=500))
                self.assertEqual(item['height'],1)
                self.assertEqual(asset_catalog.catalog_items(),[item])
                self.assertEqual((models/item['folder']/'originals/original.fbx').read_bytes(),b'original')
                self.assertFalse(any(path.name.startswith('.incoming-') for path in models.iterdir()))
                job['state']='ready'
                job.pop('item')
                self.assertEqual(asset_import.publish(job,{}),item)
                self.assertEqual(job['state'],'published')

    def archive(self, files):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        identifier = 'a' * 32
        upload = root / identifier / 'uploads'
        upload.mkdir(parents=True)
        with zipfile.ZipFile(upload / 'model.zip', 'w') as archive:
            for name, content in files:
                archive.writestr(name, content)
        return root, dict(id=identifier, files=['model.zip'])

    def test_zip_traversal_and_multiple_models(self):
        for files in [[('../escape.fbx', b'bad')], [('C:/escape.fbx', b'bad')],
                      [('/absolute.fbx', b'bad')], [('one.fbx', b'1'), ('two.blend', b'2')]]:
            root, job = self.archive(files)
            with self.subTest(files=files), mock.patch.object(asset_import, 'STAGING', root), self.assertRaises(ValueError):
                asset_import.unpack(job)

    def test_single_nested_model_and_texture(self):
        root, job = self.archive([('model/chair.fbx', b'fbx'), ('maps/wood.jpg', b'image'), ('readme.exe', b'ignored')])
        with mock.patch.object(asset_import, 'STAGING', root):
            model = asset_import.unpack(job)
        self.assertEqual(model.name, 'chair.fbx')
        self.assertTrue((root/job['id']/'input/maps/wood.jpg').is_file())
        self.assertFalse((root/job['id']/'input/readme.exe').exists())

    def test_expansion_limit(self):
        root, job = self.archive([('chair.fbx', b'x'*100)])
        with mock.patch.object(asset_import, 'STAGING', root), mock.patch.object(asset_import, 'MAX_EXPANDED', 50), self.assertRaises(ValueError):
            asset_import.unpack(job)

    def test_server_owned_paths_and_dimensions(self):
        item = dict(type='user_'+'a'*32, folder='user-'+'a'*32, name='Chair', category='Furniture', width=1, height=1, depth=1)
        self.assertTrue(asset_catalog.valid_item(item))
        for field, value in [('folder','../../external'), ('width',float('nan')), ('height',True), ('type','dentalchair')]:
            self.assertFalse(asset_catalog.valid_item({**item,field:value}))


class ImportHTTPTests(render_tests.HTTPTests):
    def test_catalog_and_bad_requests(self):
        self.assertEqual(self.request('GET','/api/assets/catalog')[0],200)
        self.assertEqual(self.request('POST','/api/assets/imports',body='{}')[0],403)
        self.assertEqual(self.request('POST','/api/assets/imports',headers={'X-CADtour':'1'},body='{}')[0],400)
        self.assertEqual(self.request('PUT','/api/assets/imports/'+'a'*32+'/files?name=x.fbx',body='x')[0],403)
        self.assertEqual(self.request('GET','/.asset-imports/private.blend')[0],403)

    def test_upload_validation_and_cancellation(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(asset_import,'STAGING',Path(directory)):
            headers={'X-CADtour':'1'}
            status, data=self.request('POST','/api/assets/imports',headers=headers,body=json.dumps({'name':'Test','category':'Tests'}))
            self.assertEqual(status,201)
            job=json.loads(data)
            endpoint='/api/assets/imports/'+job['id']
            self.assertEqual(self.request('PUT',endpoint+'/files?name=../x.fbx',headers=headers,body='x')[0],400)
            self.assertEqual(self.request('PUT',endpoint+'/files?name=program.exe',headers=headers,body='x')[0],400)
            self.assertEqual(self.request('PUT',endpoint+'/files?name=one.fbx',headers={**headers,'Content-Length':str(asset_import.MAX_UPLOAD+1)})[0],400)
            self.assertEqual(self.request('PUT',endpoint+'/files?name=one.fbx',headers=headers,body='x')[0],200)
            self.assertEqual(self.request('PUT',endpoint+'/files?name=one.fbx',headers=headers,body='x')[0],400)
            self.assertEqual(self.request('POST',endpoint+'/publish',headers=headers,body='{}')[0],400)
            self.assertEqual(self.request('DELETE',endpoint,headers=headers)[0],200)
            self.assertEqual(json.loads(self.request('GET',endpoint)[1])['state'],'cancelled')
            asset_import.JOBS.pop(job['id'],None)


if __name__=='__main__':
    unittest.main()
