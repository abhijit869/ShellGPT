import http.client
import json
import subprocess
import threading
import unittest
from unittest.mock import patch
from server import APIError, make_server, parse_request, run_claude


class BridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_server(port=0, api_key='key', backend=lambda *args: ('Hello 世界', {'input_tokens': 3, 'output_tokens': 2}, 'end_turn'))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, path, body, key='key'):
        conn = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        conn.request('POST', path, json.dumps(body).encode(), {'Authorization': 'Bearer ' + key})
        response = conn.getresponse()
        result = response.status, response.read().decode()
        conn.close()
        return result

    def body(self, **kwargs):
        return {'model': 'sonnet', 'messages': [{'role': 'user', 'content': 'Hello'}], 'max_tokens': 100, **kwargs}

    def test_responses(self):
        for path in ('/v1/messages', '/v1/chat/completions'):
            status, raw = self.request(path, self.body())
            self.assertEqual(status, 200)
            data = json.loads(raw)
            if path.endswith('messages'):
                self.assertEqual(data['content'][0]['text'], 'Hello 世界')
                self.assertEqual(data['stop_reason'], 'end_turn')
            else:
                self.assertEqual(data['choices'][0]['message']['content'], 'Hello 世界')
                self.assertEqual(data['usage']['total_tokens'], 5)

    def test_streams(self):
        for path in ('/v1/messages', '/v1/chat/completions'):
            body = self.body(stream=True)
            if path.endswith('completions'):
                body['stream_options'] = {'include_usage': True}
            status, raw = self.request(path, body)
            self.assertEqual(status, 200)
            events = [json.loads(line[6:]) for line in raw.splitlines() if line.startswith('data: ') and line != 'data: [DONE]']
            if path.endswith('messages'):
                self.assertEqual(events[0]['type'], 'message_start')
                self.assertEqual(events[-1]['type'], 'message_stop')
                self.assertEqual(events[2]['delta']['text'], 'Hello 世界')
            else:
                self.assertTrue(raw.endswith('data: [DONE]\n\n'))
                self.assertEqual(events[-1]['usage']['total_tokens'], 5)

    def test_validation(self):
        self.assertEqual(self.request('/v1/messages', self.body(), key='wrong')[0], 401)
        for body in ([], self.body(tools=[]), self.body(stream='true'), self.body(max_tokens=-1), self.body(messages=[{'role': 'user', 'content': [{'type': 'image'}]}])):
            self.assertEqual(self.request('/v1/chat/completions', body)[0], 400)

    def test_history(self):
        body = self.body(messages=[{'role': 'system', 'content': 'brief'}, {'role': 'user', 'content': 'A'}, {'role': 'assistant', 'content': 'B'}, {'role': 'user', 'content': 'C'}])
        _, system, prompt, _ = parse_request(body, False)
        self.assertEqual(system, 'brief')
        self.assertEqual(json.loads(prompt.split('\n', 1)[1])[1]['role'], 'assistant')

    @patch('server.subprocess.run')
    def test_cli(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, '{"result":"ok","usage":{}}', '')
        self.assertEqual(run_claude('sonnet', 'brief', 'hello', 100)[0], 'ok')
        args, kwargs = run.call_args
        self.assertEqual(args[0][args[0].index('--tools') + 1], '')
        self.assertEqual(kwargs['input'], 'hello')
        self.assertEqual(kwargs['env']['CLAUDE_CODE_MAX_OUTPUT_TOKENS'], '100')
        self.assertNotIn('shell', kwargs)

    @patch('server.subprocess.run')
    def test_failures(self, run):
        for value, status in [(subprocess.TimeoutExpired('claude', 1), 504), (FileNotFoundError(), 503)]:
            run.side_effect = value
            with self.assertRaises(APIError) as caught:
                run_claude('sonnet', '', 'hi', None)
            self.assertEqual(caught.exception.status, status)
        run.side_effect = None
        run.return_value = subprocess.CompletedProcess([], 1, '{"is_error":true}', 'secret')
        with self.assertRaises(APIError) as caught:
            run_claude('sonnet', '', 'hi', None)
        self.assertEqual(caught.exception.status, 502)


if __name__ == '__main__':
    unittest.main()
