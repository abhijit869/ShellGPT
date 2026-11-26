import http.client
import json
import threading
import unittest
from unittest.mock import patch

from gateway import APIError, events, make_gateway, make_message, route, validate


def request_body():
    return {'model': 'codex', 'max_tokens': 100, 'messages': [{'role': 'user', 'content': 'hello'}],
            'tools': [{'name': 'Read', 'input_schema': {'type': 'object'}}]}


class GatewayTests(unittest.TestCase):
    def test_routes(self):
        self.assertEqual(route('codex/custom-model'), ('codex', 'custom-model'))
        self.assertEqual(route('antigravity/custom-model'), ('antigravity', 'custom-model'))
        with self.assertRaises(APIError):
            route('unknown')

    def test_tool_response_and_stream(self):
        message = make_message(request_body(), {'text': 'Reading', 'tool_calls': [
            {'name': 'Read', 'arguments': '{"file_path":"/tmp/example"}'}]}, {'input_tokens': 20})
        self.assertEqual(message['stop_reason'], 'tool_use')
        self.assertEqual(message['content'][1]['input']['file_path'], '/tmp/example')
        stream = list(events(message))
        self.assertEqual(stream[0][0], 'message_start')
        self.assertEqual(stream[-1][0], 'message_stop')
        delta = [data['delta'] for kind, data in stream if kind == 'content_block_delta'][1]
        self.assertEqual(json.loads(delta['partial_json']), {'file_path': '/tmp/example'})

    def test_bad_tools(self):
        for choice in (None, [], {'type': 'wrong'}, {'type': 'tool', 'name': 'missing'}):
            with self.assertRaises(APIError):
                validate({**request_body(), 'tool_choice': choice})
        for call in ({'name': 'Delete', 'arguments': '{}'}, {'name': 'Read', 'arguments': '[]'}, {'name': 'Read', 'arguments': 'oops'}):
            with self.assertRaises(APIError):
                make_message(request_body(), {'text': '', 'tool_calls': [call]}, {})
        body = request_body()
        body['tool_choice'] = {'type': 'any'}
        with self.assertRaises(APIError):
            make_message(body, {'text': 'no tool', 'tool_calls': []}, {})

    def test_tool_history(self):
        body = request_body()
        body['messages'] += [{'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 'id', 'name': 'Read', 'input': {}}]},
                             {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'id', 'content': 'hello'}]}]
        validate(body)
        body['messages'][-1]['content'][0]['content'] = [{'type': 'image'}]
        with self.assertRaises(APIError):
            validate(body)

    def test_http_auth_stream_and_missing_anthropic_key(self):
        seen = []
        def backend(body):
            seen.append(body)
            return make_message(body, {'text': 'OK', 'tool_calls': []}, {})
        server = make_gateway(0, 'key', backend)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def request(path, body, key='key'):
            conn = http.client.HTTPConnection(*server.server_address, timeout=10)
            conn.request('POST', path, json.dumps(body), {'x-api-key': key})
            response = conn.getresponse()
            result = response.status, response.read().decode()
            conn.close()
            return result
        try:
            body = request_body()
            self.assertEqual(request('/v1/messages', body, 'bad')[0], 401)
            self.assertFalse(seen)
            self.assertEqual(request('/v1/messages', body)[0], 200)
            body['stream'] = True
            status, raw = request('/v1/messages?beta=true', body)
            self.assertEqual(status, 200)
            self.assertIn('event: message_stop', raw)
            self.assertIn('OK', raw)
            self.assertEqual(request('/v1/messages/count_tokens', body)[0], 501)
            with patch.dict('os.environ', {}, clear=True):
                body['model'] = 'anthropic'
                self.assertEqual(request('/v1/messages', body)[0], 503)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
