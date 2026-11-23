"""Local, text-only Anthropic/OpenAI API adapter for Claude Code."""

import argparse
import hmac
import json
import os
import shutil
import subprocess
import tempfile
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class APIError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def text_content(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for block in value:
            if not isinstance(block, dict) or block.get('type') != 'text' or not isinstance(block.get('text'), str):
                raise APIError('Only text content is supported; images and tool calls are not supported.')
            parts.append(block['text'])
        return '\n'.join(parts)
    raise APIError('Content must be a string or a list of text blocks.')


def parse_request(body, anthropic):
    if not isinstance(body, dict):
        raise APIError('Request must be a JSON object.')
    supported = {'model', 'messages', 'stream', 'max_tokens'}
    supported |= {'system'} if anthropic else {'max_completion_tokens', 'stream_options'}
    unknown = set(body) - supported
    if unknown:
        raise APIError('Unsupported parameters: ' + ', '.join(sorted(unknown)))
    model = body.get('model', os.environ.get('CLAUDE_MODEL', 'sonnet'))
    if not isinstance(model, str) or not model.strip() or model.startswith('-'):
        raise APIError('model must be a nonempty model name.')
    if not isinstance(body.get('stream', False), bool):
        raise APIError('stream must be a boolean.')
    options = body.get('stream_options', {})
    if not isinstance(options, dict) or set(options) - {'include_usage'} or not isinstance(options.get('include_usage', False), bool):
        raise APIError('stream_options only supports boolean include_usage.')
    limit = body.get('max_completion_tokens', body.get('max_tokens'))
    if 'max_completion_tokens' in body and 'max_tokens' in body:
        raise APIError('Specify only one token limit.')
    if anthropic and limit is None:
        raise APIError('max_tokens is required.')
    if limit is not None and (type(limit) is not int or limit < 1):
        raise APIError('Token limit must be a positive integer.')
    messages = body.get('messages')
    if not isinstance(messages, list) or not messages:
        raise APIError('messages must be a nonempty list.')
    system = [text_content(body['system'])] if 'system' in body else []
    history = []
    for message in messages:
        if not isinstance(message, dict) or set(message) - {'role', 'content'}:
            raise APIError('Each message must contain only role and content.')
        role = message.get('role')
        allowed = {'user', 'assistant'} if anthropic else {'system', 'developer', 'user', 'assistant'}
        if role not in allowed:
            raise APIError('Unsupported message role.')
        content = text_content(message.get('content'))
        if role in {'system', 'developer'}:
            system.append(content)
        else:
            history.append({'role': role, 'content': content})
    if not history or history[-1]['role'] != 'user':
        raise APIError('The final conversation message must have role user.')
    # The CLI accepts a prompt, not a native Messages API conversation. Encode
    # history explicitly instead of discarding earlier turns or their roles.
    prompt = history[0]['content'] if len(history) == 1 else (
        'Continue the following conversation. Respond to its final user message.\n'
        + json.dumps(history, ensure_ascii=False)
    )
    return model, '\n\n'.join(system), prompt, limit


def run_claude(model, system, prompt, limit):
    executable = os.environ.get('CLAUDE_BIN', 'claude')
    command = [executable, '-p', '--output-format', 'json', '--model', model,
               '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
               '--disable-slash-commands', '--no-session-persistence',
               '--settings', '{"disableAllHooks":true}', '--setting-sources', '']
    if system:
        command += ['--system-prompt', system]
    env = os.environ.copy()
    if limit is not None:
        env['CLAUDE_CODE_MAX_OUTPUT_TOKENS'] = str(limit)
    try:
        # Keep project instructions out of API conversations.
        with tempfile.TemporaryDirectory(prefix='shellgpt-') as directory:
            result = subprocess.run(command, input=prompt, text=True, encoding='utf-8',
                                    capture_output=True, cwd=directory, env=env,
                                    timeout=float(os.environ.get('CLAUDE_TIMEOUT', '180')))
    except FileNotFoundError as exc:
        raise APIError('Claude Code was not found. Install it or set CLAUDE_BIN.', 503) from exc
    except subprocess.TimeoutExpired as exc:
        raise APIError('Claude Code timed out.', 504) from exc
    try:
        data = json.loads(result.stdout)
    except (ValueError, TypeError) as exc:
        raise APIError('Claude Code returned no valid JSON. Check claude auth status and CLI configuration.', 502) from exc
    if result.returncode or not isinstance(data, dict) or data.get('is_error'):
        raise APIError('Claude Code failed. Check claude auth status and upstream model access.', 502)
    if not isinstance(data.get('result'), str):
        raise APIError('Claude Code returned no text result.', 502)
    usage = data.get('usage') or {}
    return data['result'], usage, data.get('stop_reason')


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, data):
        raw = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def error(self, error):
        kind = 'invalid_request_error' if error.status == 400 else 'api_error'
        if error.status == 401:
            kind = 'authentication_error'
        detail = {'type': kind, 'message': str(error)}
        self.reply(error.status, {'type': 'error', 'error': detail} if self.path.split('?')[0] == '/v1/messages' else {'error': detail})

    def authorize(self):
        key = self.server.api_key
        supplied = self.headers.get('x-api-key', '')
        bearer = self.headers.get('Authorization', '')
        if bearer.startswith('Bearer '):
            supplied = bearer[7:]
        if key and not hmac.compare_digest(key.encode(), supplied.encode()):
            raise APIError('Invalid API key.', 401)

    def do_GET(self):
        try:
            path = self.path.split('?')[0]
            if path == '/health':
                self.reply(200, {'status': 'ok', 'claude_installed': bool(shutil.which(os.environ.get('CLAUDE_BIN', 'claude')))})
                return
            self.authorize()
            if path != '/v1/models':
                raise APIError('Endpoint not found.', 404)
            self.reply(200, {'object': 'list', 'data': [
                {'id': model, 'object': 'model', 'created': 0, 'owned_by': 'anthropic'}
                for model in ('sonnet', 'opus', 'haiku')]})
        except APIError as exc:
            self.error(exc)

    def do_POST(self):
        try:
            self.authorize()
            path = self.path.split('?')[0]
            if path not in {'/v1/messages', '/v1/chat/completions'}:
                raise APIError('Endpoint not found.', 404)
            if self.headers.get('Transfer-Encoding'):
                raise APIError('Transfer-Encoding is not supported.')
            try:
                length = int(self.headers.get('Content-Length', '0'))
            except ValueError as exc:
                raise APIError('Invalid Content-Length.') from exc
            if not 0 < length <= 1024 * 1024:
                raise APIError('Request body must be between 1 byte and 1 MiB.', 413)
            try:
                body = json.loads(self.rfile.read(length))
            except (ValueError, UnicodeError) as exc:
                raise APIError('Invalid JSON.') from exc
            anthropic = path == '/v1/messages'
            args = parse_request(body, anthropic)
            if not self.server.capacity.acquire(blocking=False):
                raise APIError('Too many concurrent requests.', 429)
            try:
                content, usage, stop = self.server.backend(*args)
            finally:
                self.server.capacity.release()
            model = args[0]
            input_tokens = usage.get('input_tokens', 0)
            output_tokens = usage.get('output_tokens', 0)
            if anthropic:
                token_usage = {k: usage.get(k, 0) for k in ('input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens')}
                response = {'id': 'msg_' + uuid.uuid4().hex, 'type': 'message', 'role': 'assistant',
                            'model': model, 'content': [{'type': 'text', 'text': content}],
                            'stop_reason': 'max_tokens' if stop == 'max_tokens' else 'end_turn',
                            'stop_sequence': None, 'usage': token_usage}
            else:
                input_tokens += usage.get('cache_creation_input_tokens', 0) + usage.get('cache_read_input_tokens', 0)
                response = {'id': 'chatcmpl-' + uuid.uuid4().hex, 'object': 'chat.completion',
                            'created': int(time.time()), 'model': model,
                            'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': content},
                                         'finish_reason': 'length' if stop == 'max_tokens' else 'stop'}],
                            'usage': {'prompt_tokens': input_tokens, 'completion_tokens': output_tokens,
                                      'total_tokens': input_tokens + output_tokens}}
            if body.get('stream'):
                self.stream(response, anthropic, body.get('stream_options', {}).get('include_usage', False))
            else:
                self.reply(200, response)
        except APIError as exc:
            self.error(exc)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def stream(self, response, anthropic, include_usage):
        # Buffered SSE: generation finishes before the first event is sent.
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()

        def emit(data, event=None):
            payload = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False)
            self.wfile.write(((f'event: {event}\n' if event else '') + f'data: {payload}\n\n').encode())
            self.wfile.flush()

        if anthropic:
            start = {**response, 'content': [], 'stop_reason': None, 'usage': {**response['usage'], 'output_tokens': 0}}
            events = [
                ('message_start', {'message': start}),
                ('content_block_start', {'index': 0, 'content_block': {'type': 'text', 'text': ''}}),
                ('content_block_delta', {'index': 0, 'delta': {'type': 'text_delta', 'text': response['content'][0]['text']}}),
                ('content_block_stop', {'index': 0}),
                ('message_delta', {'delta': {'stop_reason': response['stop_reason'], 'stop_sequence': None}, 'usage': {'output_tokens': response['usage']['output_tokens']}}),
                ('message_stop', {})]
            for event, data in events:
                emit({'type': event, **data}, event)
        else:
            base = {k: response[k] for k in ('id', 'created', 'model')}
            base['object'] = 'chat.completion.chunk'
            choice = response['choices'][0]
            for delta, finish in [({'role': 'assistant'}, None), ({'content': choice['message']['content']}, None), ({}, choice['finish_reason'])]:
                chunk = {**base, 'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
                if include_usage:
                    chunk['usage'] = None
                emit(chunk)
            if include_usage:
                emit({**base, 'choices': [], 'usage': response['usage']})
            emit('[DONE]')


def make_server(host='127.0.0.1', port=8000, api_key='', backend=run_claude):
    import threading
    server = ThreadingHTTPServer((host, port), Handler)
    server.api_key = api_key
    server.backend = backend
    server.capacity = threading.BoundedSemaphore(4)
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default=os.environ.get('HOST', '127.0.0.1'))
    parser.add_argument('--port', type=int, default=int(os.environ.get('PORT', '8000')))
    args = parser.parse_args()
    key = os.environ.get('SHELLGPT_API_KEY', '')
    if args.host not in {'127.0.0.1', 'localhost', '::1'} and not key:
        parser.error('Set SHELLGPT_API_KEY before listening beyond localhost.')
    with make_server(args.host, args.port, key) as server:
        print(f'ShellGPT listening at http://{args.host}:{args.port}', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
