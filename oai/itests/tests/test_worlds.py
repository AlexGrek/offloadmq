"""VR Worlds authorization, validation and optional real GPU lifecycle."""
import base64
import time

import httpx
import pytest


class TestWorldsAuthorization:
    @pytest.mark.parametrize("method,path", [
        ("GET", "/capabilities"), ("GET", "/jobs"), ("POST", "/jobs"),
        ("GET", "/jobs/1"), ("DELETE", "/jobs/1"),
        ("POST", "/jobs/1/poll"), ("POST", "/jobs/1/cancel"),
        ("POST", "/jobs/1/retry"), ("POST", "/jobs/1/share"),
        ("GET", "/jobs/1/scene.ply"), ("GET", "/jobs/1/preview.png"),
    ])
    @pytest.mark.parametrize("token", [None, "invalid-token"])
    def test_auth_required(self, fresh_client: httpx.Client, method: str, path: str, token: str | None):
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        response = fresh_client.request(method, "/api/worlds" + path, headers=headers, json={})
        assert response.status_code == 401

    def test_empty_history(self, client: httpx.Client, new_user: dict):
        response = client.get('/api/worlds/jobs', headers=new_user['headers'])
        assert response.status_code == 200
        assert response.json() == []

    @pytest.mark.parametrize("exp", [1, 9999999999])
    @pytest.mark.parametrize("file", ['scene.ply', 'preview.png'])
    def test_public_rejects_bad_signature(self, fresh_client: httpx.Client, exp: int, file: str):
        response = fresh_client.get(f'/api/worlds/public/1/{file}', params={'u': 1, 'exp': exp, 'sig': 'bad'})
        assert response.status_code == 403


class TestWorldsValidation:
    @pytest.mark.parametrize("changes", [
        {'input_image_id': 'invalid'}, {'input_image_id': '1'},
        {'mode': 'cubemap'}, {'max_width': 4096}, {'fill_lean': -1},
        {'near': 10, 'far': 10.1}, {'capability': 'imggen.test'},
        # world.pano360 knobs (and a ready panorama belongs to world.splat).
        {'pitch': 90}, {'prompt': 'x' * 2001},
        {'capability': 'world.pano360', 'mode': 'pano'},
    ])
    def test_invalid_input_creates_no_job(self, client: httpx.Client, new_user: dict, changes: dict):
        body = {'capability': 'world.splat', 'input_image_id': '1', **changes}
        response = client.post('/api/worlds/jobs', headers=new_user['headers'], json=body)
        assert response.status_code == 400, response.text
        assert client.get('/api/worlds/jobs', headers=new_user['headers']).json() == []


class TestWorldsRuntime:
    def test_lifecycle_range_share_and_ownership(self, client: httpx.Client, fresh_client: httpx.Client,
                                               new_user: dict, session_headers: dict):
        headers = new_user['headers']
        caps = client.get('/api/worlds/capabilities', headers=headers)
        if caps.status_code != 200 or not any(c['base'] == 'world.splat' for c in caps.json()['capabilities']):
            pytest.skip('world.splat is offline')
        # A small valid image keeps the GPU test inexpensive.
        png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')
        upload = client.post('/api/images/upload', headers=headers, files={'file': ('source.png', png, 'image/png')})
        assert upload.status_code == 200, upload.text
        image_id = upload.json()['image_id']
        foreign = client.post('/api/worlds/jobs', headers=session_headers,
                              json={'capability': 'world.splat', 'input_image_id': image_id})
        assert foreign.status_code == 400
        created = client.post('/api/worlds/jobs', headers=headers,
                              json={'capability': 'world.splat', 'input_image_id': image_id, 'max_width': 256})
        assert created.status_code == 201, created.text
        path = '/api/worlds/jobs/' + created.json()['job_id']
        try:
            for method, suffix in [('GET', ''), ('DELETE', ''), ('POST', '/poll'), ('POST', '/cancel'),
                                   ('POST', '/retry'), ('POST', '/share'), ('GET', '/scene.ply'), ('GET', '/preview.png')]:
                assert client.request(method, path + suffix, headers=session_headers).status_code == 404
            deadline = time.monotonic() + 180
            while time.monotonic() < deadline:
                response = client.post(path + '/poll', headers=headers, timeout=120)
                assert response.status_code == 200, response.text
                job = response.json()
                if job['status'] in ('completed', 'failed', 'canceled'):
                    break
                time.sleep(1)
            assert job['status'] == 'completed', job
            scene = client.get(path + '/scene.ply', headers={**headers, 'Range': 'bytes=0-99'})
            assert scene.status_code == 206 and len(scene.content) == 100
            assert scene.content.startswith(b'ply\n')
            assert scene.headers['content-range'].startswith('bytes 0-99/')
            shared = client.post(path + '/share', headers=headers).json()
            public = fresh_client.get(shared['ply_url'], headers={'Range': 'bytes=0-99'})
            assert public.status_code == 206 and public.content == scene.content
            assert public.headers['referrer-policy'] == 'no-referrer'
        finally:
            client.post(path + '/cancel', headers=headers)
            assert client.delete(path, headers=headers).status_code == 204
        assert fresh_client.get(shared['ply_url']).status_code == 403
