import { z } from 'zod';
import type { ChatMessage, GenerateRequest, GenerateResponse, ToolCallRequest } from './index.ts';

export function openAIHistory(messages: ChatMessage[]) {
  return messages.map(m => ({
    role: m.role, content: m.content,
    ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
    ...(m.toolCalls ? { tool_calls: m.toolCalls.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.arguments) } })) } : {}),
  }));
}
const Chunk = z.object({
  id: z.string().optional(),
  choices: z.array(z.object({
    index: z.number().optional(), finish_reason: z.string().nullable().optional(),
    delta: z.object({
      content: z.string().nullable().optional(),
      tool_calls: z.array(z.object({ index: z.number().int().nonnegative(), id: z.string().optional(), function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).optional() })).optional(),
    }).optional(),
  })),
  usage: z.object({ prompt_tokens: z.number().nonnegative(), completion_tokens: z.number().nonnegative(), total_tokens: z.number().nonnegative() }).nullable().optional(),
});
export async function streamOpenAI(options: {
  url: string; headers: Record<string, string>; providerId: string; model: string;
  request: GenerateRequest; signal: AbortSignal; maxTokens: number; temperature: number;
  onChunk: (delta: { text?: string; toolCall?: ToolCallRequest }) => void;
}): Promise<GenerateResponse> {
  const { request } = options;
  const response = await fetch(options.url, {
    method: 'POST', headers: options.headers, signal: options.signal,
    body: JSON.stringify({ model: options.model, messages: openAIHistory(request.messages), stream: true,
      max_tokens: request.maxTokens ?? options.maxTokens, temperature: request.temperature ?? options.temperature,
      ...(request.tools?.length ? { tools: request.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) } : {}),
      ...(request.toolChoice ? { tool_choice: typeof request.toolChoice === 'string' ? request.toolChoice : { type: 'function', function: request.toolChoice } } : {}),
    }),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status} from ${options.providerId}`); }
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
    await response.body?.cancel(); throw new Error(`Provider ${options.providerId} did not return an SSE stream; configure streaming: false if this endpoint only supports JSON.`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', text = '', id = '', done = false, finished = false;
  let totalBytes = 0;
  let finishReason: GenerateResponse['finishReason'] = 'stop';
  let usage: GenerateResponse['usage'] = { inputTokens: 'unavailable', outputTokens: 'unavailable', totalTokens: 'unavailable', measurementType: 'unavailable', estimatedCostUsd: 'unavailable' };
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  const event = (frame: string) => {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data === '[DONE]') { done = true; return; }
    const chunk = Chunk.parse(JSON.parse(data));
    if (chunk.id) id = chunk.id;
    if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens, totalTokens: chunk.usage.total_tokens, measurementType: 'measured', estimatedCostUsd: 'unavailable' };
    for (const choice of chunk.choices) {
      if (choice.index && choice.index !== 0) continue;
      if (choice.finish_reason) {
        finished = true;
        finishReason = choice.finish_reason === 'tool_calls' ? 'tool_calls' : choice.finish_reason === 'length' ? 'length' : choice.finish_reason === 'stop' ? 'stop' : 'error';
      }
      if (choice.delta?.content) { text += choice.delta.content; options.onChunk({ text: choice.delta.content }); }
      for (const partial of choice.delta?.tool_calls ?? []) {
        const call = calls.get(partial.index) ?? { id: '', name: '', arguments: '' };
        if (partial.id) call.id = partial.id;
        if (partial.function?.name) call.name += partial.function.name;
        if (partial.function?.arguments) call.arguments += partial.function.arguments;
        calls.set(partial.index, call);
      }
    }
  };
  try {
    while (!done) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > 8 * 1024 * 1024) throw new Error('Provider stream exceeded the 8 MiB response limit.');
      buffer += decoder.decode(next.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2); event(frame);
        if (done) break;
      }
    }
    if (!done || !finished) throw new Error('Provider stream ended before a complete response; partial output is not a successful result.');
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => {
      if (!call.id || !call.name) throw new Error('Incomplete streamed tool call.');
      return { id: call.id, name: call.name, arguments: z.record(z.string(), z.unknown()).parse(JSON.parse(call.arguments || '{}')) };
    });
    for (const toolCall of toolCalls) options.onChunk({ toolCall });
    return { id, providerId: options.providerId, model: options.model, text, toolCalls, finishReason, usage };
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
