# -*- coding: utf-8 -*-
from odoo.exceptions import ValidationError
from odoo.tests.common import HttpCase, TransactionCase, tagged

# ภาพ PNG 1x1 pixel ของจริง — ให้ตรวจ mimetype/สตรีมได้โดยไม่พึ่งไฟล์นอก repo
PNG_1PX = (
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
    'AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
)
# วิดีโอปลอมสำหรับเทสต์ชนิดไฟล์ (ตรวจจากชื่อไฟล์ ไม่ใช่เนื้อไฟล์)
FAKE_MP4 = 'AAAAGGZ0eXBtcDQyAAAAAG1wNDJpc29t'


@tagged('post_install', '-at_install')
class TestCdsMedia(TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.config = cls.env['pos.config'].create({'name': 'CDS Test POS'})

    def _create_media(self, filename, data=PNG_1PX):
        return self.env['ko.cds.media'].create({
            'config_id': self.config.id,
            'media_file': data,
            'media_filename': filename,
        })

    def test_image_media_type(self):
        media = self._create_media('promo.png')
        self.assertEqual(media.media_type, 'image')
        self.assertEqual(media.mimetype, 'image/png')
        self.assertEqual(media.name, 'promo')

    def test_video_media_type_from_filename(self):
        # attachment ของ binary field ถูกตั้งชื่อตามฟิลด์ ทำให้ Odoo เดาเนื้อวิดีโอ
        # เป็น octet-stream — ประเภทจึงต้องมาจากชื่อไฟล์ที่อัปโหลด
        media = self._create_media('ads.mp4', data=FAKE_MP4)
        self.assertEqual(media.media_type, 'video')
        self.assertEqual(media.mimetype, 'video/mp4')

    def test_disallowed_file_rejected(self):
        with self.assertRaises(ValidationError):
            self._create_media('notes.txt', data='aGVsbG8=')

    def test_playlist_in_customer_display_data(self):
        image = self._create_media('promo.png')
        video = self._create_media('ads.mp4', data=FAKE_MP4)
        inactive = self._create_media('old.png')
        inactive.active = False

        data = self.config._get_customer_display_data()
        self.assertIn('ko_cds', data)
        ko_cds = data['ko_cds']
        self.assertEqual(ko_cds['idle_seconds'], 15)
        self.assertEqual(ko_cds['image_seconds'], 8)
        playlist = ko_cds['playlist']
        self.assertEqual([entry['id'] for entry in playlist], [image.id, video.id])
        self.assertEqual([entry['type'] for entry in playlist], ['image', 'video'])
        for entry in playlist:
            self.assertIn('access_token=%s' % self.config.access_token, entry['url'])
            self.assertTrue(entry['url'].startswith(
                '/ko_cds/media/%s/' % self.config.id))

    def test_playlist_skips_config_of_other_shop(self):
        other_config = self.env['pos.config'].create({'name': 'CDS Other POS'})
        self._create_media('promo.png')
        data = other_config._get_customer_display_data()
        self.assertEqual(data['ko_cds']['playlist'], [])


@tagged('post_install', '-at_install')
class TestCdsMediaRoute(HttpCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.config = cls.env['pos.config'].create({'name': 'CDS Route POS'})
        cls.media = cls.env['ko.cds.media'].create({
            'config_id': cls.config.id,
            'media_file': PNG_1PX,
            'media_filename': 'promo.png',
        })

    def test_media_requires_access_token(self):
        base = '/ko_cds/media/%s/%s' % (self.config.id, self.media.id)
        self.assertEqual(self.url_open(base).status_code, 404)
        self.assertEqual(
            self.url_open(base + '?access_token=wrong-token').status_code, 404)

    def test_media_served_with_access_token(self):
        url = '/ko_cds/media/%s/%s?access_token=%s' % (
            self.config.id, self.media.id, self.config.access_token)
        response = self.url_open(url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get('Content-Type'), 'image/png')
        self.assertTrue(response.content.startswith(b'\x89PNG'))

    def test_media_of_other_config_not_served(self):
        other = self.env['pos.config'].create({'name': 'CDS Route POS 2'})
        url = '/ko_cds/media/%s/%s?access_token=%s' % (
            other.id, self.media.id, other.access_token)
        self.assertEqual(self.url_open(url).status_code, 404)
