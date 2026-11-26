"""Anthropic-format gateway: Claude Code -> Codex / Antigravity / Anthropic."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
import urllib.error
import urllib.request
import uuid
from http.server import ThreadingHTTPServer

from server import APIError, Handler

SCHEMA = {
    'type': 'object', 'additionalProperties': False,
    'properties': {
        'text': {'type': 'string'},
        'tool_calls': {'type': 'array', 'items': {
            'type': 'object', 'additionalProperties': False,
            'properties': {'name': {'type': 'string'}, 'arguments': {'type': 'string'}},
            'required': ['name', 'arguments'],
        }},
    }, 'required': ['text', 'tool_calls'],
}


def route(model):
    if not isinstance(model, str):
        raise APIError('model must be a string')
    provider, _, selected = model.partition('/')
    defaults = {'codex': os.getenv('CODEX_MODEL', 'gpt-6-astra'),
                'antigravity': os.getenv('ANTIGRAVITY_MODEL', 'gemini-3.8-flash-low'),
                'anthropic': os.getenv('ANTHROPIC_MODEL', 'claude-sonnet-5-5')}
    if provider not in defaults:
        raise APIError('Use model codex, antigravity, anthropic, or provider/model-id.')
    return provider, selected or defaults[provider]


def validate(body):
    if not isinstance(body, dict):
        raise APIError('Request must be an object.')
    route(body.get('model'))
    if not isinstance(body.get('messages'), list) or not body['messages']:
        raise APIError('messages must be a nonempty list.')
    if type(body.get('max_tokens')) is not int or body['max_tokens'] < 1:
        raise APIError('max_tokens must be positive.')
    if type(body.get('stream', False)) is not bool:
        raise APIError('stream must be boolean.')
    if not isinstance(body.get('tools', []), list):
        raise APIError('tools must be a list.')
    choice = body.get('tool_choice', {'type': 'auto'})
    if not isinstance(choice, dict) or choice.get('type') not in {'auto', 'none', 'any', 'tool'}:
        raise APIError('Invalid tool_choice.')
    if choice.get('type') == 'tool' and choice.get('name') not in {t.get('name') for t in body.get('tools', []) if isinstance(t, dict)}:
        raise APIError('tool_choice names an undeclared tool.')
    for tool in body.get('tools', []):
        if not isinstance(tool, dict) or not isinstance(tool.get('name'), str) or not isinstance(tool.get('input_schema'), dict):
            raise APIError('Only client-defined tools with name and input_schema are supported.')
    # Reject multimodal content rather than pretending the backend saw it.
    def content(value):
        if isinstance(value, str):
            return
        if not isinstance(value, list):
            raise APIError('Message content must be text or content blocks.')
        for block in value:
            if not isinstance(block, dict):
                raise APIError('Invalid content block.')
            kind = block.get('type')
            if kind == 'tool_result':
                content(block.get('content', ''))
            elif kind not in {'text', 'tool_use', 'thinking', 'redacted_thinking'}:
                raise APIError('Unsupported content block: ' + str(kind))
    if 'system' in body:
        content(body['system'])
    for message in body['messages']:
        if not isinstance(message, dict) or message.get('role') not in {'user', 'assistant', 'system'}:
            raise APIError('Invalid message role.')
        content(message.get('content'))


def command_run(command, prompt, directory):
    env = os.environ.copy()
    # Never send the gateway's client credentials to a nested provider process.
    for key in ('ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'SHELLGPT_API_KEY', 'CLAUDECODE'):
        env.pop(key, None)
    try:
        with subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True, encoding='utf-8',
                              cwd=directory, env=env, start_new_session=True) as process:
            try:
                out, err = process.communicate(prompt, timeout=float(os.getenv('GATEWAY_TIMEOUT', '180')))
            except subprocess.TimeoutExpired as exc:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
                raise APIError('Provider CLI timed out.', 504) from exc
            if process.returncode:
                raise APIError('Provider CLI failed. Check its login, model access, and quota.', 502)
            return out
    except FileNotFoundError as exc:
        raise APIError('Provider CLI is not installed.', 503) from exc


def cli_generate(body):
    provider, model = route(body['model'])
    prompt = (
        'You are a model backend for an external Claude Code client. Produce the NEXT assistant turn '
        'for the supplied conversation, honoring its system instructions. Do not run your own tools, '
        'read files, browse, or execute commands. The external client executes tools. '
        'If a tool is needed, return its exact declared name and JSON-encoded arguments in tool_calls. '
        'Otherwise return the answer in text and an empty tool_calls array. '
        'Do not invent tool results. If the history contains tool results, use them to continue. '
        'Return only the required JSON object. Respect tool_choice. '
        'Keep the response within the requested max_tokens budget (best effort).\n'
        + json.dumps({key: body[key] for key in ('system', 'messages', 'tools', 'tool_choice', 'max_tokens') if key in body}, ensure_ascii=False)
    )
    with tempfile.TemporaryDirectory(prefix='shellgpt-provider-') as directory:
        schema = Path(directory) / 'schema.json'
        schema.write_text(json.dumps(SCHEMA))
        if provider == 'codex':
            output = Path(directory) / 'result.json'
            command = [os.getenv('CODEX_BIN', 'codex'), 'exec', '--ignore-user-config',
                       '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check',
                       '--color', 'never', '--json', '-m', model,
                       '--output-schema', str(schema), '--output-last-message', str(output), '-']
            raw = command_run(command, prompt, directory)
            if not output.exists():
                raise APIError('Codex returned no final output.', 502)
            result = json.loads(output.read_text())
            usage = {}
            for line in raw.splitlines():
                event = json.loads(line)
                if event.get('type') == 'turn.completed':
                    usage = event.get('usage', {})
        elif provider == 'antigravity':
            command = [os.getenv('ANTIGRAVITY_BIN', 'agy'), '--input-format', 'stream-json',
                       '--output-format', 'stream-json', '--model', model, '--mode', 'plan',
                       '--settings', '{"toolPermission":"strict"}', '--sandbox',
                       '--disable-slash-commands', '--json-schema', str(schema)]
            raw = command_run(command, json.dumps({'event': 'user', 'message': {'content': prompt}}) + '\n', directory)
            results = [event['result'] for line in raw.splitlines() if (event := json.loads(line)).get('event') == 'result']
            if not results or results[-1].get('status') != 'SUCCESS':
                raise APIError('Antigravity returned no successful result. Check account quota.', 502)
            envelope = results[-1]
            result = envelope.get('structured_output')
            if result is None:
                result = json.loads(envelope['response'])
            usage = envelope.get('usage', {})
        else:
            raise APIError('Anthropic uses HTTP forwarding.')
    return make_message(body, result, usage)


def make_message(body, result, usage):
    if not isinstance(result, dict) or not isinstance(result.get('text'), str) or not isinstance(result.get('tool_calls'), list):
        raise APIError('Provider returned an invalid structured response.', 502)
    content = []
    if result['text']:
        content.append({'type': 'text', 'text': result['text']})
    names = {tool['name'] for tool in body.get('tools', [])}
    for call in result['tool_calls']:
        if not isinstance(call, dict) or call.get('name') not in names:
            raise APIError('Provider requested an undeclared tool.', 502)
        try:
            arguments = json.loads(call['arguments'])
        except (KeyError, TypeError, ValueError) as exc:
            raise APIError('Provider returned invalid tool arguments.', 502) from exc
        if not isinstance(arguments, dict):
            raise APIError('Tool arguments must be an object.', 502)
        content.append({'type': 'tool_use', 'id': 'toolu_' + uuid.uuid4().hex,
                        'name': call['name'], 'input': arguments})
    choice = body.get('tool_choice', {}).get('type', 'auto')
    if choice == 'none' and result['tool_calls']:
        raise APIError('Provider violated tool_choice none.', 502)
    if choice in {'any', 'tool'} and not result['tool_calls']:
        raise APIError('Provider did not return the required tool call.', 502)
    if choice == 'tool' and any(call['name'] != body['tool_choice'].get('name') for call in result['tool_calls']):
        raise APIError('Provider selected the wrong required tool.', 502)
    if not content:
        content = [{'type': 'text', 'text': ''}]
    return {'id': 'msg_' + uuid.uuid4().hex, 'type': 'message', 'role': 'assistant',
            'model': body['model'], 'content': content,
            'stop_reason': 'tool_use' if result['tool_calls'] else 'end_turn',
            'stop_sequence': None,
            'usage': {'input_tokens': usage.get('input_tokens', 0), 'output_tokens': usage.get('output_tokens', 0)}}


def events(message):
    yield 'message_start', {'message': {**message, 'content': [], 'stop_reason': None,
                                      'usage': {**message['usage'], 'output_tokens': 0}}}
    for index, block in enumerate(message['content']):
        if block['type'] == 'text':
            start = {'type': 'text', 'text': ''}
            delta = {'type': 'text_delta', 'text': block['text']}
        else:
            start = {**block, 'input': {}}
            delta = {'type': 'input_json_delta', 'partial_json': json.dumps(block['input'])}
        yield 'content_block_start', {'index': index, 'content_block': start}
        yield 'content_block_delta', {'index': index, 'delta': delta}
        yield 'content_block_stop', {'index': index}
    yield 'message_delta', {'delta': {'stop_reason': message['stop_reason'], 'stop_sequence': None},
                            'usage': {'output_tokens': message['usage']['output_tokens']}}
    yield 'message_stop', {}


class GatewayHandler(Handler):
    def error(self, error):
        kind = 'invalid_request_error' if error.status == 400 else 'api_error'
        if error.status == 401:
            kind = 'authentication_error'
        self.reply(error.status, {'type': 'error', 'error': {'type': kind, 'message': str(error)}})

    def do_GET(self):
        try:
            self.authorize()
            path = self.path.split('?')[0]
            if path == '/health':
                self.reply(200, {'status': 'ok', 'service': 'provider-gateway'})
            elif path == '/v1/models':
                self.reply(200, {'data': [{'id': name, 'type': 'model', 'display_name': name,
                                        'created_at': '2026-01-01T00:00:00Z'}
                                       for name in ('codex', 'antigravity', 'anthropic')], 'has_more': False})
            else:
                raise APIError('Endpoint not found.', 404)
        except APIError as exc:
            self.error(exc)

    def do_POST(self):
        streaming = False
        try:
            self.authorize()
            path = self.path.split('?')[0]
            if path not in {'/v1/messages', '/v1/messages/count_tokens'}:
                raise APIError('Endpoint not found.', 404)
            if self.headers.get('Transfer-Encoding'):
                raise APIError('Transfer-Encoding is not supported.')
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 8 * 1024 * 1024:
                raise APIError('Request must be between 1 byte and 8 MiB.', 413)
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise APIError('Request must be an object.')
            provider, model = route(body.get('model'))
            if provider == 'anthropic':
                self.forward(body, model)
                return
            if path.endswith('count_tokens'):
                raise APIError('Exact token counting unavailable for CLI backends.', 501)
            validate(body)
            if not self.server.capacity.acquire(blocking=False):
                raise APIError('Gateway busy.', 429)
            try:
                # Keep Claude Code's streaming connection alive while a CLI works.
                if body.get('stream'):
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/event-stream')
                    self.send_header('Cache-Control', 'no-cache')
                    self.end_headers()
                    streaming = True
                    result, errors = [], []
                    done = threading.Event()
                    def work():
                        try:
                            result.append(self.server.backend(body))
                        except Exception as exc:
                            errors.append(exc)
                        finally:
                            done.set()
                    worker = threading.Thread(target=work, daemon=True)
                    worker.start()
                    try:
                        while not done.wait(5):
                            self.emit('ping', {})
                        if errors:
                            raise errors[0]
                        message = result[0]
                    finally:
                        worker.join()
                    for event, data in events(message):
                        self.emit(event, data)
                else:
                    self.reply(200, self.server.backend(body))
            finally:
                self.server.capacity.release()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            error = exc if isinstance(exc, APIError) else APIError('Invalid request or malformed provider response.', 502)
            if isinstance(exc, (json.JSONDecodeError, UnicodeError, ValueError)):
                error = APIError('Invalid JSON, length, or provider JSON.', 400)
            if streaming:
                self.emit('error', {'error': {'type': 'api_error', 'message': str(error)}})
            else:
                self.error(error)

    def emit(self, event, data):
        payload = json.dumps({'type': event, **data}, ensure_ascii=False)
        self.wfile.write(f'event: {event}\ndata: {payload}\n\n'.encode())
        self.wfile.flush()

    def forward(self, body, model):
        key = os.getenv('ANTHROPIC_API_KEY')
        if not key:
            raise APIError('Set ANTHROPIC_API_KEY on the gateway for the Anthropic provider.', 503)
        headers = {key: value for key, value in self.headers.items()
                   if key.lower().startswith(('anthropic-', 'x-claude-code-'))}
        headers.update({'x-api-key': key, 'Content-Type': 'application/json'})
        headers.setdefault('anthropic-version', '2023-06-01')
        request = urllib.request.Request('https://api.anthropic.com' + self.path,
                                         data=json.dumps({**body, 'model': model}).encode(), headers=headers)
        try:
            upstream = urllib.request.urlopen(request, timeout=float(os.getenv('GATEWAY_TIMEOUT', '180')))
        except urllib.error.HTTPError as exc:
            upstream = exc
        except urllib.error.URLError as exc:
            raise APIError('Unable to reach Anthropic.', 502) from exc
        with upstream:
            self.send_response(upstream.status)
            for key, value in upstream.headers.items():
                if key.lower() in {'content-type', 'retry-after', 'x-should-retry', 'request-id'} or key.lower().startswith('anthropic-'):
                    self.send_header(key, value)
            self.end_headers()
            while chunk := upstream.read1(65536):
                self.wfile.write(chunk)
                self.wfile.flush()


def make_gateway(port=8001, key='', backend=cli_generate):
    server = ThreadingHTTPServer(('127.0.0.1', port), GatewayHandler)
    server.api_key = key
    server.backend = backend
    server.capacity = threading.BoundedSemaphore(2)
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=int(os.getenv('GATEWAY_PORT', '8001')))
    args = parser.parse_args()
    key = os.getenv('SHELLGPT_API_KEY')
    if not key:
        parser.error('Set SHELLGPT_API_KEY (or use bash gateway-start.sh).')
    with make_gateway(args.port, key) as server:
        print(f'Provider gateway at http://127.0.0.1:{args.port}', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
