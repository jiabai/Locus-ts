"""网页保存契约的 Python 基准生成器。

把 `worker_core/web_page_contract.py` 的 URL 规范化、请求/正文校验、来源元数据与
保存用 Markdown 拼装跑在同一批输入上，输出成 JSON 供 TypeScript 侧逐字节比对。
可复现：改了任何一侧的规则就重新生成并评审差异。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))

from worker_core.web_page_contract import (  # noqa: E402
    WEB_PAGE_CONTRACT_VERSION,
    WebPageSource,
)
from worker_core.web_page_contract import (  # noqa: E402
    canonical_web_url,
    parse_web_page_request,
    validate_article_payload,
    validate_web_task_id,
)


def build_saved_markdown_helper(title: str, url: str, extracted_at: str, markdown: str) -> str:
    """与 `web_page_storage.save_web_page` 的拼装逐字符一致（原文是内联代码）。"""
    safe_title = title.translate(str.maketrans({
        char: "\\" + char for char in "\\`*_{}[]<>()#+-.!|"
    }))
    return f"# {safe_title}\n\n<{url}>\n\n{extracted_at}\n\n{markdown}"

FIXTURE = (
    Path(__file__).resolve().parents[2] / "worker-ts" / "tests" / "fixtures" / "web-page-golden.json"
)

URLS = [
    "https://www.python.org/doc/?id=12",
    "https://www.python.org/?token=secret#fragment",
    "https://www.python.org/?page=2&id=3&id=4&post_id=7",
    "https://www.python.org/?p=0&p=10&story_id=42&x=1",
    "https://www.python.org/?id=123456789012345678901&keep=1",
    "http://www.python.org:80/",
    "https://www.python.org:443/a?b=%20",
    "http://www.python.org:443/",
    "http://www.python.org:080/",
    "https://bücher.io:443/章节/一个b",
    "https://xn--bcher-kva.io/",
    "https://straße.io/",
    "https://日本.io/章节",
    "https://BÜCHER.example.io/",
    "http://8.8.8.8/",
    "http://224.0.0.1/x",
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://100.64.0.1/",
    "http://192.0.2.1/",
    "http://1.2.3/",
    "http://999.1.1.1/",
    "http://[2a00:1450:4001:81b::2008]/",
    "http://[::ffff:8.8.8.8]/",
    "http://[::1]/",
    "http://[2001:db8::1]/",
    "http://[v1.x]/",
    "http://[example.com]/",
    "http://[::1%25eth0]/",
    "https://example.com/a/../b?x=1",
    "https://example.com/./",
    "https://example.com/a/b/..",
    "https://example.com/a/%2e%2e/b",
    "https://example.com/a/%2E/b",
    "https://example.com/..%2f/b",
    "https://example.com/%2e%2e",
    "http://localhost/",
    "http://example.com/",
    "http://example.io./",
    "http://my_host.example.io/",
    "http://io/",
    "http://example.123/",
    "http://example.io.internal/",
    "http://USER@example.io/",
    "http://example.io:99/",
    "http://example.io:/",
    "HTTP://EXAMPLE.IO/A",
    "http://example.io/%70%73",
    "http://%70%73.example.io/",
    "http://example.io/?q=a+b&empty=&flag&=%z",
    "http://example.io/?x=%zz&y=%C3%BC",
    "http://example.io/?中文=值",
    "http://example.io/?p=10&p=10&id=x",
    "http://example.io/?page=02&article_id=007",
    "http://example.io/docs;p=1",
    "ftp://example.io/",
    "http:///path",
    "http://example.io\\x",
    "https://example.io/a b",
    "https://example.io/\t",
    "http://-example.io/",
    "http://example-.io/",
    "http://a--b.io/",
    "http://" + "x" * 64 + ".io/",
    "http://" + "x" * 63 + ".io/",
    "http://" + "a." * 120 + "io",
    "http://8.8.8.8:443/",
    "https://8.8.8.8:80/",
]

ARTICLE_OK = {
    "title": "公开文章与本地保存",
    "text": "段落保留原始UTF-8字节🙂。\r\n" * 6,
    "markdown": "## 文章\n\n段落保留结构。\n\n- 第一条\n- 第二条\n",
    "sourceUrl": "https://www.python.org/doc/?id=12",
}

ARTICLES = [
    ARTICLE_OK,
    {**ARTICLE_OK, "title": "带有 Markdown 标点 #1 *强调* [链接] <括号> `code` _{}[]<>()#+-.!|"},
    {**ARTICLE_OK, "title": " leading space"},
    {**ARTICLE_OK, "title": "" },
    {**ARTICLE_OK, "title": "x" * 513},
    {**ARTICLE_OK, "title": "标题\u0000"},
    {**ARTICLE_OK, "text": "太短"},
    {**ARTICLE_OK, "markdown": "   "},
    {**ARTICLE_OK, "sourceUrl": "https://www.python.org/doc/?id=12#frag"},
    {**ARTICLE_OK, "sourceUrl": "https://www.python.org:443/doc/?id=12"},
    {**ARTICLE_OK, "extra": True},
    {"title": "t", "text": ARTICLE_OK["text"], "markdown": "m"},
    {**ARTICLE_OK, "text": 42},
]

REQUEST_OK = {
    "contract_version": WEB_PAGE_CONTRACT_VERSION,
    "operation_id": "00000000-0000-0000-0000-000000000001",
    "task_id": "20261102-123456-web-0123456789abcdef",
    "article": ARTICLE_OK,
}

REQUESTS = [
    REQUEST_OK,
    {**REQUEST_OK, "contract_version": 1},
    {**REQUEST_OK, "contract_version": True},
    {**REQUEST_OK, "contract_version": "2"},
    {**REQUEST_OK, "task_id": "../escape"},
    {**REQUEST_OK, "task_id": "20261102-123456-local-abcdef0123456789"},
    {**REQUEST_OK, "operation_id": "article_123"},
    {**REQUEST_OK, "operation_id": "00000000-0000-0000-0000-0000000000011"},
    {**REQUEST_OK, "operation_id": "00000000-0000-0000-0000-00000000000Z"},
    {**REQUEST_OK, "extra": True},
    {k: v for k, v in REQUEST_OK.items() if k != "article"},
    {**REQUEST_OK, "article": {**ARTICLE_OK, "text": "短"}},
]

SOURCES = [
    ("https://www.python.org/doc/?id=12", "公开文章与本地保存", "2026-11-02T12:34:56Z"),
    ("https://www.python.org:443/doc/?id=12", "t", "2026-11-02T12:34:56Z"),
    ("https://www.python.org/doc/", "标题", "2026-11-02T12:34:56.123Z"),
    ("https://www.python.org/doc/", "标题", "2026-11-02T12:34:56+00:00"),
    ("https://www.python.org/doc/", "标题", "2026-02-30T12:34:56Z"),
    ("https://www.python.org/doc/", "标题", "2026-11-02T25:34:56Z"),
    ("https://www.python.org/doc/", " 空白标题 ", "2026-11-02T12:34:56Z"),
    ("https://www.python.org/doc/", "x" * 513, "2026-11-02T12:34:56Z"),
]

TASK_IDS = [
    "20261102-123456-web-0123456789abcdef",
    "20261102-123456-web-0123456789abcdeG",
    "20261102-123456-web-0123456789abc",
    "20261102-123456-local-abcdef0123456789",
    "",
]


def attempt(action):
    try:
        return {"ok": True, "value": action()}
    except ValueError as error:
        return {"ok": False, "error": str(error)}


def main() -> None:
    fixture = {
        "contractVersion": WEB_PAGE_CONTRACT_VERSION,
        "urls": [{"input": url, "result": attempt(lambda url=url: canonical_web_url(url))}
                 for url in URLS],
        "articles": [{"payload": article, "result": attempt(lambda a=article: validate_article_payload(a))}
                     for article in ARTICLES],
        "requests": [{"payload": request, "result": attempt(lambda r=request: parse_web_page_request(r).article)}
                     for request in REQUESTS],
        "sources": [
            {"url": url, "title": title, "extractedAt": extracted,
             "result": attempt(lambda u=url, t=title, e=extracted: WebPageSource(u, t, e).to_dict())}
            for url, title, extracted in SOURCES
        ],
        "taskIds": [{"input": task_id, "result": attempt(lambda t=task_id: validate_web_task_id(t))}
                    for task_id in TASK_IDS],
        "savedMarkdown": [
            {"title": "公开文章与本地保存", "url": "https://www.python.org/doc/?id=12",
             "extractedAt": "2026-11-02T12:34:56Z", "markdown": ARTICLE_OK["markdown"],
             "expected": build_saved_markdown_helper("公开文章与本地保存",
                                                     "https://www.python.org/doc/?id=12",
                                                     "2026-11-02T12:34:56Z", ARTICLE_OK["markdown"])},
            {"title": "标点 #1 *强调* [链接] (括号) `code` _{}[]<>()#+-.!|",
             "url": "http://example.io/", "extractedAt": "2026-11-02T12:34:56Z", "markdown": "\n\n正文\n",
             "expected": build_saved_markdown_helper(
                 "标点 #1 *强调* [链接] (括号) `code` _{}[]<>()#+-.!|",
                 "http://example.io/", "2026-11-02T12:34:56Z", "\n\n正文\n")},
        ],
    }
    FIXTURE.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {FIXTURE} ({FIXTURE.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
