"""Test both HTTP endpoints against the real installed Claude Code CLI."""
import http.client
import json
import os
import threading

from server import make_server


def main():
    key = os.environ.get('SHELLGPT_API_KEY', 'smoke-test-local')
    server = make_server(port=0, api_key=key)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    success = True
    try:
        for path in ('/v1/messages', '/v1/chat/completions'):
            conn = http.client.HTTPConnection(*server.server_address, timeout=200)
            try:
                conn.request('POST', path, json.dumps({
                    'model': os.environ.get('CLAUDE_MODEL', 'sonnet'),
                    'messages': [{'role': 'user', 'content': 'Reply with exactly OK.'}],
                    'max_tokens': 64,
                }), {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key})
                response = conn.getresponse()
                data = json.loads(response.read())
                if response.status == 200:
                    text = data['content'][0]['text'] if path.endswith('messages') else data['choices'][0]['message']['content']
                    passed = text.strip() == 'OK'
                    print(f'{path}: HTTP 200; expected reply: {passed}')
                    success = success and passed
                else:
                    print(f'{path}: HTTP {response.status}; {data["error"]["message"]}')
                    success = False
            finally:
                conn.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    return 0 if success else 1


if __name__ == '__main__':
    raise SystemExit(main())
