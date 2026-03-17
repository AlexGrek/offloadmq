"""Storage API tests for OffloadMQ.

Tests the client-facing Storage API under `/api/storage/*`.
Auth via X-API-Key header carrying the client API key.
"""

import pytest
import requests
import io


SERVER_URL = "http://localhost:3069"
API_KEY = "client_secret_key_123"
MGMT_TOKEN = "this-is-for-testing-management-tokens"


@pytest.fixture(autouse=True)
def cleanup_storage():
    """Clean up all storage buckets before and after each test."""
    # Clean before
    headers = {"Authorization": f"Bearer {MGMT_TOKEN}"}
    requests.delete(f"{SERVER_URL}/management/storage/buckets", headers=headers, timeout=10)
    yield
    # Clean after
    requests.delete(f"{SERVER_URL}/management/storage/buckets", headers=headers, timeout=10)


class TestStorageLimits:
    """Test /api/storage/limits endpoint."""

    def test_get_limits(self):
        """Test retrieving storage limits."""
        url = f"{SERVER_URL}/api/storage/limits"
        headers = {"X-API-Key": API_KEY}

        response = requests.get(url, headers=headers, timeout=10)
        assert response.status_code == 200

        data = response.json()
        assert "max_buckets_per_key" in data
        assert "bucket_size_bytes" in data
        assert "bucket_ttl_minutes" in data
        assert data["max_buckets_per_key"] > 0
        assert data["bucket_size_bytes"] > 0
        assert data["bucket_ttl_minutes"] > 0

    def test_get_limits_missing_api_key(self):
        """Test that missing API key is rejected."""
        url = f"{SERVER_URL}/api/storage/limits"

        response = requests.get(url, timeout=10)
        assert response.status_code in [401, 403]  # Either unauthorized or forbidden


class TestBucketLifecycle:
    """Test bucket creation, listing, and deletion."""

    def test_create_bucket(self):
        """Test creating a new bucket."""
        url = f"{SERVER_URL}/api/storage/bucket/create"
        headers = {"X-API-Key": API_KEY}

        response = requests.post(url, headers=headers, timeout=10)
        assert response.status_code == 201

        data = response.json()
        assert "bucket_uid" in data
        assert "created_at" in data
        assert isinstance(data["bucket_uid"], str)
        assert len(data["bucket_uid"]) > 0

    def test_list_buckets_empty(self):
        """Test listing buckets when none exist."""
        url = f"{SERVER_URL}/api/storage/buckets"
        headers = {"X-API-Key": API_KEY}

        response = requests.get(url, headers=headers, timeout=10)
        assert response.status_code == 200

        data = response.json()
        assert "buckets" in data
        assert isinstance(data["buckets"], list)

    def test_create_and_list_bucket(self):
        """Test creating a bucket and then listing it."""
        headers = {"X-API-Key": API_KEY}

        # Create bucket
        create_url = f"{SERVER_URL}/api/storage/bucket/create"
        create_response = requests.post(create_url, headers=headers, timeout=10)
        assert create_response.status_code == 201
        bucket_uid = create_response.json()["bucket_uid"]

        # List buckets
        list_url = f"{SERVER_URL}/api/storage/buckets"
        list_response = requests.get(list_url, headers=headers, timeout=10)
        assert list_response.status_code == 200

        data = list_response.json()
        bucket_uids = [b["bucket_uid"] for b in data["buckets"]]
        assert bucket_uid in bucket_uids

    def test_bucket_limit_enforcement(self):
        """Test that bucket limit is enforced."""
        headers = {"X-API-Key": API_KEY}
        create_url = f"{SERVER_URL}/api/storage/bucket/create"

        # Get current limits
        limits_url = f"{SERVER_URL}/api/storage/limits"
        limits = requests.get(limits_url, headers=headers, timeout=10).json()
        max_buckets = limits["max_buckets_per_key"]

        # Create max_buckets buckets
        for i in range(max_buckets):
            response = requests.post(create_url, headers=headers, timeout=10)
            assert response.status_code == 201, f"Failed to create bucket {i+1}"

        # Try to create one more, should fail
        response = requests.post(create_url, headers=headers, timeout=10)
        assert response.status_code == 409  # Conflict


class TestFileUpload:
    """Test file upload functionality."""

    def _create_bucket(self):
        """Helper to create a bucket."""
        headers = {"X-API-Key": API_KEY}
        url = f"{SERVER_URL}/api/storage/bucket/create"
        response = requests.post(url, headers=headers, timeout=10)
        assert response.status_code == 201
        return response.json()["bucket_uid"]

    def test_upload_file(self):
        """Test uploading a single file."""
        bucket_uid = self._create_bucket()
        headers = {"X-API-Key": API_KEY}

        url = f"{SERVER_URL}/api/storage/bucket/{bucket_uid}/upload"
        files = {"file": ("test.txt", b"Hello World")}

        response = requests.post(url, headers=headers, files=files, timeout=10)
        assert response.status_code == 201

        data = response.json()
        assert "file_uid" in data
        assert "sha256" in data
        assert data["size"] == 11  # "Hello World" is 11 bytes

    def test_upload_and_stat(self):
        """Test uploading a file and checking bucket stat."""
        bucket_uid = self._create_bucket()
        headers = {"X-API-Key": API_KEY}

        # Upload file
        upload_url = f"{SERVER_URL}/api/storage/bucket/{bucket_uid}/upload"
        files = {"file": ("test.txt", b"Hello World")}
        upload_response = requests.post(upload_url, headers=headers, files=files, timeout=10)
        assert upload_response.status_code == 201
        file_uid = upload_response.json()["file_uid"]

        # Get bucket stat
        stat_url = f"{SERVER_URL}/api/storage/bucket/{bucket_uid}/stat"
        stat_response = requests.get(stat_url, headers=headers, timeout=10)
        assert stat_response.status_code == 200

        data = stat_response.json()
        assert "files" in data
        assert len(data["files"]) == 1
        assert data["files"][0]["file_uid"] == file_uid
        assert data["files"][0]["size"] == 11

    def test_upload_multiple_files(self):
        """Test uploading multiple files to the same bucket."""
        bucket_uid = self._create_bucket()
        headers = {"X-API-Key": API_KEY}
        upload_url = f"{SERVER_URL}/api/storage/bucket/{bucket_uid}/upload"

        # Upload multiple files
        file_uids = []
        for i in range(3):
            files = {"file": (f"file{i}.txt", f"Content {i}".encode())}
            response = requests.post(upload_url, headers=headers, files=files, timeout=10)
            assert response.status_code == 201
            file_uids.append(response.json()["file_uid"])

        # Verify all files are listed
        stat_url = f"{SERVER_URL}/api/storage/bucket/{bucket_uid}/stat"
        stat_response = requests.get(stat_url, headers=headers, timeout=10)
        assert stat_response.status_code == 200

        data = stat_response.json()
        assert len(data["files"]) == 3
        listed_uids = {f["file_uid"] for f in data["files"]}
        assert listed_uids == set(file_uids)

    def test_upload_large_file(self):
        """Test uploading a larger file."""
        bucket_uid = self._create_bucket()
        headers = {"X-API-Key": API_KEY}

        # Create 1MB of data
        large_data = b"x" * (1024 * 1024)

        url = f"{SERVER_URL}/api/storage/bucket/{bucket_uid}/upload"
        files = {"file": ("large.bin", large_data)}

        response = requests.post(url, headers=headers, files=files, timeout=30)
        assert response.status_code == 201

        data = response.json()
        assert data["size"] == 1024 * 1024

    def test_upload_exceeds_bucket_size(self):
        """Test that uploads exceeding bucket size are rejected."""
        bucket_uid = self._create_bucket()
        headers = {"X-API-Key": API_KEY}

        # Get bucket size limit
        limits_url = f"{SERVER_URL}/api/storage/limits"
        limits = requests.get(limits_url, headers=headers, timeout=10).json()
        bucket_size = limits["bucket_size_bytes"]

        # Try to upload a file larger than bucket size
        oversized_data = b"x" * (bucket_size + 1)

        url = f"{SERVER_URL}/api/storage/bucket/{bucket_uid}/upload"
        files = {"file": ("oversized.bin", oversized_data)}

        response = requests.post(url, headers=headers, files=files, timeout=30)
        assert response.status_code == 400  # Bad Request


class TestFileOperations:
    """Test file-specific operations."""

    def _create_bucket_with_file(self):
        """Helper to create a bucket and upload a file."""
        headers = {"X-API-Key": API_KEY}

        # Create bucket
        create_url = f"{SERVER_URL}/api/storage/bucket/create"
        bucket_uid = requests.post(create_url, headers=headers, timeout=10).json()["bucket_uid"]

        # Upload file
        upload_url = f"{SERVER_URL}/api/storage/bucket/{bucket_uid}/upload"
        files = {"file": ("test.txt", b"Hello World")}
        file_uid = requests.post(upload_url, headers=headers, files=files, timeout=10).json()["file_uid"]

        return bucket_uid, file_uid

    def test_get_file_hash(self):
        """Test retrieving file SHA-256 hash."""
        bucket_uid, file_uid = self._create_bucket_with_file()
        headers = {"X-API-Key": API_KEY}

        url = f"{SERVER_URL}/api/storage/bucket/{bucket_uid}/file/{file_uid}/hash"
        response = requests.get(url, headers=headers, timeout=10)
        assert response.status_code == 200

        data = response.json()
        assert "sha256" in data
        assert len(data["sha256"]) == 64  # SHA-256 hex string is 64 chars

    def test_delete_file(self):
        """Test deleting a single file."""
        bucket_uid, file_uid = self._create_bucket_with_file()
        headers = {"X-API-Key": API_KEY}

        # Delete file
        delete_url = f"{SERVER_URL}/api/storage/bucket/{bucket_uid}/file/{file_uid}"
        response = requests.delete(delete_url, headers=headers, timeout=10)
        assert response.status_code == 200

        data = response.json()
        assert data["deleted_file_uid"] == file_uid

        # Verify file is gone from stat
        stat_url = f"{SERVER_URL}/api/storage/bucket/{bucket_uid}/stat"
        stat_response = requests.get(stat_url, headers=headers, timeout=10)
        assert stat_response.status_code == 200

        stat_data = stat_response.json()
        assert len(stat_data["files"]) == 0

    def test_delete_nonexistent_file(self):
        """Test deleting a file that doesn't exist."""
        bucket_uid = self._create_bucket_with_file()[0]
        headers = {"X-API-Key": API_KEY}

        url = f"{SERVER_URL}/api/storage/bucket/{bucket_uid}/file/nonexistent"
        response = requests.delete(url, headers=headers, timeout=10)
        assert response.status_code == 404


class TestBucketDeletion:
    """Test bucket deletion."""

    def test_delete_empty_bucket(self):
        """Test deleting an empty bucket."""
        headers = {"X-API-Key": API_KEY}

        # Create bucket
        create_url = f"{SERVER_URL}/api/storage/bucket/create"
        bucket_uid = requests.post(create_url, headers=headers, timeout=10).json()["bucket_uid"]

        # Delete bucket
        delete_url = f"{SERVER_URL}/api/storage/bucket/{bucket_uid}"
        response = requests.delete(delete_url, headers=headers, timeout=10)
        assert response.status_code == 200

        data = response.json()
        assert data["deleted_bucket_uid"] == bucket_uid

        # Verify bucket is gone
        list_url = f"{SERVER_URL}/api/storage/buckets"
        list_response = requests.get(list_url, headers=headers, timeout=10)
        bucket_uids = [b["bucket_uid"] for b in list_response.json()["buckets"]]
        assert bucket_uid not in bucket_uids

    def test_delete_bucket_with_files(self):
        """Test deleting a bucket that contains files."""
        headers = {"X-API-Key": API_KEY}

        # Create bucket
        create_url = f"{SERVER_URL}/api/storage/bucket/create"
        bucket_uid = requests.post(create_url, headers=headers, timeout=10).json()["bucket_uid"]

        # Upload files
        upload_url = f"{SERVER_URL}/api/storage/bucket/{bucket_uid}/upload"
        for i in range(3):
            files = {"file": (f"file{i}.txt", b"content")}
            requests.post(upload_url, headers=headers, files=files, timeout=10)

        # Delete bucket
        delete_url = f"{SERVER_URL}/api/storage/bucket/{bucket_uid}"
        response = requests.delete(delete_url, headers=headers, timeout=10)
        assert response.status_code == 200

    def test_delete_nonexistent_bucket(self):
        """Test deleting a bucket that doesn't exist."""
        headers = {"X-API-Key": API_KEY}

        url = f"{SERVER_URL}/api/storage/bucket/nonexistent"
        response = requests.delete(url, headers=headers, timeout=10)
        assert response.status_code == 404


class TestStorageAuthorization:
    """Test that storage operations respect API key ownership."""

    def test_cannot_access_other_key_bucket(self):
        """Test that one API key cannot access buckets of another."""
        # Create bucket with first key
        headers1 = {"X-API-Key": API_KEY}
        create_url = f"{SERVER_URL}/api/storage/bucket/create"
        bucket_uid = requests.post(create_url, headers=headers1, timeout=10).json()["bucket_uid"]

        # Try to access with a different key (we'll just use an invalid key for now)
        headers2 = {"X-API-Key": "invalid_key"}
        stat_url = f"{SERVER_URL}/api/storage/bucket/{bucket_uid}/stat"
        response = requests.get(stat_url, headers=headers2, timeout=10)
        assert response.status_code in [401, 403, 404]  # Either auth error or not found
