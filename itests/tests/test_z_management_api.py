"""Management API tests for OffloadMQ.

Tests the Management API under `/management/*`.
Auth via X-Management-Token header.
"""

import pytest
import requests
import json


SERVER_URL = "http://localhost:3069"
MGMT_TOKEN = "this-is-for-testing-management-tokens"


@pytest.fixture(scope="function", autouse=False)
def cleanup_storage():
    """Clean up all storage buckets."""
    headers = {"Authorization": f"Bearer {MGMT_TOKEN}"}
    requests.delete(f"{SERVER_URL}/management/storage/buckets", headers=headers, timeout=10)


class TestManagementAuth:
    """Test management API authentication."""

    def test_missing_management_token(self):
        """Test that requests without token are rejected."""
        url = f"{SERVER_URL}/management/agents/list"

        response = requests.get(url, timeout=10)
        assert response.status_code in [401, 403]

    def test_invalid_management_token(self):
        """Test that requests with invalid token are rejected."""
        url = f"{SERVER_URL}/management/agents/list"
        headers = {"Authorization": "Bearer invalid_token"}

        response = requests.get(url, headers=headers, timeout=10)
        assert response.status_code in [401, 403]

    def test_valid_management_token(self):
        """Test that valid token allows access."""
        url = f"{SERVER_URL}/management/agents/list"
        headers = {"Authorization": f"Bearer {MGMT_TOKEN}"}

        response = requests.get(url, headers=headers, timeout=10)
        assert response.status_code == 200


class TestAgentManagement:
    """Test agent management endpoints."""

    def _headers(self):
        """Return management headers."""
        return {"Authorization": f"Bearer {MGMT_TOKEN}"}

    def test_list_all_agents(self):
        """Test listing all agents (online and offline)."""
        url = f"{SERVER_URL}/management/agents/list"
        response = requests.get(url, headers=self._headers(), timeout=10)
        assert response.status_code == 200

        data = response.json()
        assert isinstance(data, list)
        # Should contain the test agent
        if data:
            agent = data[0]
            assert "uid" in agent
            assert "capabilities" in agent

    def test_list_online_agents(self):
        """Test listing only online agents."""
        url = f"{SERVER_URL}/management/agents/list/online"
        response = requests.get(url, headers=self._headers(), timeout=10)
        assert response.status_code == 200

        data = response.json()
        assert isinstance(data, list)
        # All agents in response should be online
        for agent in data:
            assert agent.get("online") is True or "last_contact" in agent

    def test_capabilities_online(self):
        """Test getting available capabilities from online agents."""
        url = f"{SERVER_URL}/management/capabilities/list/online"
        response = requests.get(url, headers=self._headers(), timeout=10)
        assert response.status_code == 200

        data = response.json()
        assert isinstance(data, (list, set, dict))

    def test_capabilities_online_extended(self):
        """Test getting extended capabilities from online agents."""
        url = f"{SERVER_URL}/management/capabilities/list/online_ext"
        response = requests.get(url, headers=self._headers(), timeout=10)
        assert response.status_code == 200

        data = response.json()
        assert isinstance(data, (list, set, dict))

    def test_remove_agent(self):
        """Test removing an agent."""
        # First get an agent to remove
        list_url = f"{SERVER_URL}/management/agents/list"
        list_response = requests.get(list_url, headers=self._headers(), timeout=10)
        agents = list_response.json()

        if len(agents) > 0:
            agent_id = agents[0]["uid"]

            # Remove it
            remove_url = f"{SERVER_URL}/management/agents/delete/{agent_id}"
            response = requests.post(remove_url, headers=self._headers(), timeout=10)
            assert response.status_code == 200

            # Verify it's gone
            list_response_2 = requests.get(list_url, headers=self._headers(), timeout=10)
            agents_2 = list_response_2.json()
            agent_ids = [a["agent_id"] for a in agents_2]
            assert agent_id not in agent_ids


class TestTaskManagement:
    """Test task management endpoints."""

    def _headers(self):
        """Return management headers."""
        return {"Authorization": f"Bearer {MGMT_TOKEN}"}

    def test_list_all_tasks(self):
        """Test listing all tasks."""
        url = f"{SERVER_URL}/management/tasks/list"
        response = requests.get(url, headers=self._headers(), timeout=10)
        assert response.status_code == 200

        data = response.json()
        # Should have structure: {urgent: {assigned, unassigned}, regular: {assigned, unassigned}}
        assert "urgent" in data
        assert "regular" in data
        assert "assigned" in data["urgent"]
        assert "unassigned" in data["urgent"]
        assert "assigned" in data["regular"]
        assert "unassigned" in data["regular"]

    def test_reset_tasks(self):
        """Test resetting all tasks."""
        url = f"{SERVER_URL}/management/tasks/reset"
        response = requests.post(url, headers=self._headers(), timeout=10)
        assert response.status_code == 200

        data = response.json()
        assert "result" in data

        # Verify tasks are empty
        list_url = f"{SERVER_URL}/management/tasks/list"
        list_response = requests.get(list_url, headers=self._headers(), timeout=10)
        tasks = list_response.json()
        assert len(tasks["urgent"]["assigned"]) == 0
        assert len(tasks["urgent"]["unassigned"]) == 0
        assert len(tasks["regular"]["assigned"]) == 0
        assert len(tasks["regular"]["unassigned"]) == 0

    def test_reset_agents(self):
        """Test resetting all agents."""
        url = f"{SERVER_URL}/management/agents/reset"
        response = requests.post(url, headers=self._headers(), timeout=10)
        assert response.status_code == 200

        data = response.json()
        assert "result" in data

        # Verify agents are empty
        list_url = f"{SERVER_URL}/management/agents/list"
        list_response = requests.get(list_url, headers=self._headers(), timeout=10)
        agents = list_response.json()
        assert len(agents) == 0


class TestClientKeyManagement:
    """Test client API key management."""

    def _headers(self):
        """Return management headers."""
        return {"Authorization": f"Bearer {MGMT_TOKEN}"}

    def test_list_client_keys(self):
        """Test listing all client API keys."""
        url = f"{SERVER_URL}/management/client_api_keys/list"
        response = requests.get(url, headers=self._headers(), timeout=10)
        assert response.status_code == 200

        data = response.json()
        assert isinstance(data, list)
        # Should contain the test key
        key_strings = [k.get("key") for k in data]
        assert "client_secret_key_123" in key_strings or len(data) > 0

    def test_add_client_key(self):
        """Test adding a new client API key."""
        url = f"{SERVER_URL}/management/client_api_keys/update"
        headers = self._headers()

        payload = {
            "key": "test_key_new_12345",
            "capabilities": []
        }

        response = requests.post(
            url,
            headers=headers,
            json=payload,
            timeout=10
        )
        assert response.status_code == 200

        data = response.json()
        assert data["key"] == "test_key_new_12345"

    def test_revoke_client_key(self):
        """Test revoking a client API key."""
        # First create a key to revoke
        create_url = f"{SERVER_URL}/management/client_api_keys/update"
        headers = self._headers()

        test_key = "test_key_to_revoke"
        create_payload = {
            "key": test_key,
            "capabilities": []
        }

        create_response = requests.post(
            create_url,
            headers=headers,
            json=create_payload,
            timeout=10
        )
        assert create_response.status_code == 200

        # Revoke it (using the key as identifier)
        revoke_url = f"{SERVER_URL}/management/client_api_keys/revoke/{test_key}"
        revoke_response = requests.post(revoke_url, headers=headers, timeout=10)
        assert revoke_response.status_code == 200

        data = revoke_response.json()
        assert data["isRevoked"] is True


class TestStorageManagement:
    """Test management of storage buckets."""

    def _headers(self):
        """Return management headers."""
        return {"Authorization": f"Bearer {MGMT_TOKEN}"}

    def _create_bucket_with_content(self):
        """Helper to create a bucket with a file."""
        # Create bucket
        create_url = f"{SERVER_URL}/api/storage/bucket/create"
        client_headers = {"X-API-Key": "client_secret_key_123"}
        bucket_uid = requests.post(create_url, headers=client_headers, timeout=10).json()["bucket_uid"]

        # Upload file
        upload_url = f"{SERVER_URL}/api/storage/bucket/{bucket_uid}/upload"
        files = {"file": ("test.txt", b"Hello World")}
        requests.post(upload_url, headers=client_headers, files=files, timeout=10)

        return bucket_uid

    def test_list_all_buckets(self):
        """Test listing all buckets grouped by API key."""
        url = f"{SERVER_URL}/management/storage/buckets"
        response = requests.get(url, headers=self._headers(), timeout=10)
        assert response.status_code == 200

        data = response.json()
        assert "buckets_by_key" in data

    def test_list_storage_quotas(self):
        """Test listing storage quotas and usage."""
        url = f"{SERVER_URL}/management/storage/quotas"
        response = requests.get(url, headers=self._headers(), timeout=10)
        assert response.status_code == 200

        data = response.json()
        assert "limits" in data
        assert "usage" in data
        assert "max_buckets_per_key" in data["limits"]
        assert "bucket_size_bytes" in data["limits"]
        assert "bucket_ttl_minutes" in data["limits"]

    def test_list_storage_quotas_for_key(self):
        """Test listing storage quotas for a specific API key."""
        url = f"{SERVER_URL}/management/storage/quotas"
        params = {"api_key": "client_secret_key_123"}
        response = requests.get(url, headers=self._headers(), params=params, timeout=10)
        assert response.status_code == 200

        data = response.json()
        assert "limits" in data
        assert "usage" in data

    def test_delete_bucket_via_management(self):
        """Test deleting a bucket via management API."""
        bucket_uid = self._create_bucket_with_content()

        url = f"{SERVER_URL}/management/storage/bucket/{bucket_uid}"
        response = requests.delete(url, headers=self._headers(), timeout=10)
        assert response.status_code == 200

        data = response.json()
        assert data["deleted_bucket_uid"] == bucket_uid

    def test_delete_key_buckets(self):
        """Test deleting all buckets for a specific API key."""
        # Create a few buckets
        client_headers = {"X-API-Key": "client_secret_key_123"}
        create_url = f"{SERVER_URL}/api/storage/bucket/create"

        for _ in range(2):
            requests.post(create_url, headers=client_headers, timeout=10)

        # Delete all buckets for the key
        url = f"{SERVER_URL}/management/storage/key/client_secret_key_123/buckets"
        response = requests.delete(url, headers=self._headers(), timeout=10)
        assert response.status_code == 200

    def test_purge_all_buckets(self):
        """Test purging all buckets."""
        url = f"{SERVER_URL}/management/storage/buckets"
        response = requests.delete(url, headers=self._headers(), timeout=10)
        assert response.status_code == 200

        # Verify all buckets are gone
        list_url = f"{SERVER_URL}/management/storage/buckets"
        list_response = requests.get(list_url, headers=self._headers(), timeout=10)
        data = list_response.json()

        # Should be empty or minimal
        buckets_by_key = data.get("buckets_by_key", {})
        total_buckets = sum(
            v.get("bucket_count", 0) for v in buckets_by_key.values()
        )
        assert total_buckets == 0


class TestManagementVersion:
    """Test version endpoint."""

    def _headers(self):
        """Return management headers."""
        return {"Authorization": f"Bearer {MGMT_TOKEN}"}

    def test_get_version(self):
        """Test getting version info."""
        url = f"{SERVER_URL}/management/version"
        response = requests.get(url, headers=self._headers(), timeout=10)
        assert response.status_code == 200

        data = response.json()
        assert "version" in data
