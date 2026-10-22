"""Document extraction through the bucket staging and Ollama request flow."""
from __future__ import annotations

import asyncio
import base64
import io
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock
from zipfile import ZIP_STORED, ZipFile

import pymupdf
import pytest

from offloadmq_agent.context import ExecContext
from offloadmq_agent.data import task_inputs
from offloadmq_agent.exec import llm
from offloadmq_agent.models import Task, TaskResult, TaskStatus


def _pdf(*pages: str, password: str | None = None) -> bytes:
    with pymupdf.open() as document:
        for text in pages:
            page = document.new_page()
            if text:
                page.insert_text((72, 72), text)
        if password:
            return document.tobytes(
                encryption=pymupdf.PDF_ENCRYPT_AES_256,
                owner_pw=password, user_pw=password,
            )
        return document.tobytes()


def _epub() -> bytes:
    data = io.BytesIO()
    with ZipFile(data, "w", compression=ZIP_STORED) as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr("META-INF/container.xml", '''<?xml version="1.0"?>
            <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
              <rootfiles><rootfile full-path="OEBPS/book.opf"
                media-type="application/oebps-package+xml"/></rootfiles>
            </container>''')
        archive.writestr("OEBPS/book.opf", '''<?xml version="1.0" encoding="utf-8"?>
            <package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
              <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
                <dc:identifier id="id">test</dc:identifier>
                <dc:title>Book</dc:title><dc:language>en</dc:language>
              </metadata>
              <manifest>
                <item id="second" href="a.xhtml" media-type="application/xhtml+xml"/>
                <item id="first" href="z.xhtml" media-type="application/xhtml+xml"/>
              </manifest>
              <spine><itemref idref="first"/><itemref idref="second"/></spine>
            </package>''')
        # ZIP, filename and manifest order deliberately differ from reading order.
        for name, text in [("a", "Second chapter: Привіт світ"), ("z", "First chapter")]:
            archive.writestr(f"OEBPS/{name}.xhtml", f'''<?xml version="1.0" encoding="utf-8"?>
                <html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head>
                <body><p>{text}</p></body></html>''')
    return data.getvalue()


@pytest.fixture
def ollama_post(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    session = MagicMock()
    session.__aenter__.return_value = session
    response = session.post.return_value.__aenter__.return_value
    response.status = 200
    response.content.__aiter__.return_value = [
        b'{"message":{"content":"summary"},"done":true}\n'
    ]
    monkeypatch.setattr(llm.aiohttp, "ClientSession", lambda: session)
    return session.post


def _run(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    files: dict[str, bytes],
    payload: dict[str, Any],
    *,
    cancelled: bool = False,
) -> TaskResult:
    monkeypatch.setattr(task_inputs, "pick_directory", lambda _: tmp_path)
    transport = MagicMock()

    def get(*segments: str, **kwargs: Any) -> MagicMock:
        response = MagicMock()
        if segments[-1] == "stat":
            response.json.return_value = {
                "files": [{"file_uid": str(i), "original_name": name}
                          for i, name in enumerate(files)]
            }
        else:
            response.content = list(files.values())[int(segments[-1])]
        return response

    transport.get.side_effect = get
    ctx = ExecContext(log_sink=lambda _: None, agent_transport=transport)
    if cancelled:
        ctx.cancel_event.set()
    task = Task(
        id="attachments", capability="llm.qwen3:8b", payload=payload,
        server_task={"data": {"file_bucket": ["bucket-1"]}},
    )
    return asyncio.run(llm.execute_llm(task, ctx))


def test_pdf_epub_and_images_reach_ollama(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, ollama_post: MagicMock,
) -> None:
    payload = {"messages": [
        {"role": "system", "content": "Be concise"},
        {"role": "user", "content": "Earlier question"},
        {"role": "assistant", "content": "Earlier answer"},
        {"role": "user", "content": [
            {"type": "text", "text": "Summarize the files"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,aW5saW5l"}},
        ]},
        {"role": "assistant", "content": "Tool result", "tool_calls": []},
    ]}
    result = _run(monkeypatch, tmp_path, {
        "report.PDF": _pdf("Page one", "Page two"),
        "books/story.EPUB": _epub(),
        "notes.MD": b"\xef\xbb\xbf    indented code\n\n# Notes\n\n**Read this**\n",
        "readme.TXT": "Plain text: Привіт світ".encode(),
        "picture.png": b"image bytes",
        "ignored.bin": b"not a document",
    }, payload)

    assert result.status == TaskStatus.COMPLETED
    messages = ollama_post.call_args.kwargs["json"]["messages"]
    assert messages[:3] == payload["messages"][:3]
    assert messages[-1] == payload["messages"][-1]
    content = messages[3]["content"]
    assert content.startswith("Summarize the files\n\n")
    assert "Attached file: report.PDF" in content
    assert "Attached file: books/story.EPUB" in content
    assert "Attached file: notes.MD" in content
    assert "# Notes\n\n**Read this**" in content
    assert "--- Attached file: notes.MD ---\n    indented code" in content
    assert "\ufeff" not in content
    assert "Plain text: Привіт світ" in content
    assert content.index("Page one") < content.index("Page two")
    assert content.index("First chapter") < content.index("Second chapter")
    assert "Привіт світ" in content
    assert "<p>" not in content
    assert "ignored.bin" not in content
    assert messages[3]["images"] == [
        "aW5saW5l", base64.b64encode(b"image bytes").decode("ascii")
    ]
    assert isinstance(payload["messages"][3]["content"], list)
    assert result.output["message"]["content"] == "summary"


@pytest.mark.parametrize("payload", [
    {"prompt": "Summarize"},
    {"messages": [{"role": "system", "content": "Summarize"}]},
    {"messages": [{"role": "user", "content": None}]},
])
def test_document_attached_with_prompt_or_no_user_text(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, ollama_post: MagicMock,
    payload: dict[str, Any],
) -> None:
    result = _run(monkeypatch, tmp_path, {"report.pdf": _pdf("Document text")}, payload)

    assert result.status == TaskStatus.COMPLETED
    message = ollama_post.call_args.kwargs["json"]["messages"][-1]
    assert message["role"] == "user"
    assert "Document text" in message["content"]
    if "messages" in payload:
        assert "Document text" not in str(payload["messages"])


@pytest.mark.parametrize("filename, data, error", [
    ("broken.pdf", b"invalid PDF", "Failed to extract text"),
    ("broken.epub", b"invalid EPUB", "Failed to extract text"),
    ("blank.pdf", _pdf(""), "No extractable text"),
    ("locked.pdf", _pdf("Secret", password="password"), "password-protected"),
    ("blank.txt", b" \n", "No extractable text"),
    ("broken.md", b"\xff", "Failed to extract text"),
])
def test_unreadable_documents_fail_before_inference(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, ollama_post: MagicMock,
    filename: str, data: bytes, error: str,
) -> None:
    result = _run(monkeypatch, tmp_path, {filename: data}, {"prompt": "Summarize"})

    assert result.status == TaskStatus.FAILED
    assert filename in result.error
    assert error in result.error
    ollama_post.assert_not_called()


def test_cancelled_document_task_does_not_start_inference(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, ollama_post: MagicMock,
) -> None:
    result = _run(
        monkeypatch, tmp_path, {"report.pdf": _pdf("Text")},
        {"prompt": "Summarize"}, cancelled=True,
    )

    assert result.status == TaskStatus.CANCELLED
    ollama_post.assert_not_called()
