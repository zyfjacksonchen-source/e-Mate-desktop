type JsonObject = Record<string, unknown>;

type ToolKind =
  | { type: 'function' }
  | {
      type: 'custom';
    };

export type ChatCompletionsRequest = {
  body: string;
  tools: Map<string, ToolKind>;
};

export type ChatCompletionsStreamOptions = {
  responseId: string;
  tools: Map<string, ToolKind>;
};

const requestKeys = new Set([
  'client_metadata',
  'include',
  'input',
  'instructions',
  'max_output_tokens',
  'model',
  'parallel_tool_calls',
  'prompt_cache_key',
  'reasoning',
  'service_tier',
  'store',
  'stream',
  'stream_options',
  'text',
  'tool_choice',
  'tools',
]);
const toolNamePattern = /^[A-Za-z0-9_-]{1,64}$/;

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as JsonObject;
}

function string(value: unknown, label: string, max = 4 * 1024 * 1024): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function exactKeys(value: JsonObject, allowed: Set<string>, label: string): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(`Invalid ${label}`);
}

function chatTools(value: unknown): { tools?: JsonObject[]; kinds: Map<string, ToolKind> } {
  if (value === undefined) return { kinds: new Map() };
  if (!Array.isArray(value) || value.length > 128) throw new Error('Invalid tools');
  const kinds = new Map<string, ToolKind>();
  const tools = value.map((entry) => {
    const tool = object(entry, 'tool');
    const type = tool.type;
    const name = string(tool.name, 'tool name', 64);
    if (!toolNamePattern.test(name) || kinds.has(name)) throw new Error('Invalid tool name');
    const description = string(tool.description ?? '', 'tool description', 256 * 1024);
    if (type === 'function') {
      exactKeys(tool, new Set(['defer_loading', 'description', 'name', 'parameters', 'strict', 'type']), 'tool');
      const parameters = object(tool.parameters, 'tool parameters');
      if (tool.strict !== undefined && typeof tool.strict !== 'boolean') throw new Error('Invalid tool strict mode');
      kinds.set(name, { type: 'function' });
      return {
        type: 'function',
        function: {
          name,
          description,
          parameters,
          ...(tool.strict === undefined ? {} : { strict: tool.strict }),
        },
      };
    }
    if (type === 'custom') {
      exactKeys(tool, new Set(['description', 'format', 'name', 'type']), 'tool');
      const format = object(tool.format, 'custom tool format');
      exactKeys(format, new Set(['definition', 'syntax', 'type']), 'custom tool format');
      const syntax = string(format.syntax, 'custom tool syntax', 256);
      const definition = string(format.definition, 'custom tool definition', 256 * 1024);
      if (format.type !== 'grammar') throw new Error('Unsupported custom tool format');
      kinds.set(name, { type: 'custom' });
      return {
        type: 'function',
        function: {
          name,
          description: `${description}\nInput format (${syntax}):\n${definition}`,
          parameters: {
            type: 'object',
            properties: { input: { type: 'string' } },
            required: ['input'],
            additionalProperties: false,
          },
        },
      };
    }
    throw new Error('Unsupported tool type');
  });
  return { tools, kinds };
}

function messageContent(value: unknown, role: string, allowImages: boolean): string | JsonObject[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Invalid message content');
  const parts = value.map((entry): JsonObject => {
    const part = object(entry, 'message content');
    const type = part.type;
    if ((role === 'user' && type === 'input_text') || (role === 'assistant' && type === 'output_text')) {
      exactKeys(part, new Set(['text', 'type']), 'message content');
      return { type: 'text', text: string(part.text, 'message text') };
    }
    if (role === 'user' && type === 'input_image' && allowImages) {
      exactKeys(part, new Set(['detail', 'image_url', 'type']), 'message content');
      const detail = part.detail;
      if (detail !== undefined && !['auto', 'low', 'high'].includes(String(detail))) {
        throw new Error('Invalid image detail');
      }
      return {
        type: 'image_url',
        image_url: {
          url: string(part.image_url, 'image URL'),
          ...(detail === undefined ? {} : { detail }),
        },
      };
    }
    throw new Error('Unsupported message content');
  });
  if (parts.every((part) => part.type === 'text')) return parts.map((part) => part.text).join('');
  return parts;
}

function textControls(value: unknown): { responseFormat?: JsonObject } {
  if (value === undefined || value === null) return {};
  const controls = object(value, 'text controls');
  exactKeys(controls, new Set(['format', 'verbosity']), 'text controls');
  if (
    controls.verbosity !== undefined &&
    controls.verbosity !== 'low' &&
    controls.verbosity !== 'medium' &&
    controls.verbosity !== 'high'
  ) {
    throw new Error('Invalid text verbosity');
  }
  if (controls.format === undefined || controls.format === null) return {};
  const format = object(controls.format, 'text format');
  exactKeys(format, new Set(['name', 'schema', 'strict', 'type']), 'text format');
  if (format.type !== 'json_schema' || typeof format.strict !== 'boolean') {
    throw new Error('Unsupported text format');
  }
  const name = string(format.name, 'text format name', 64);
  if (!toolNamePattern.test(name)) throw new Error('Invalid text format name');
  const schema = object(format.schema, 'text format schema');
  return {
    responseFormat: {
      type: 'json_schema',
      json_schema: { name, strict: format.strict, schema },
    },
  };
}

function validateResponsesControls(value: JsonObject): void {
  if (value.reasoning !== undefined && value.reasoning !== null) {
    const reasoning = object(value.reasoning, 'reasoning controls');
    exactKeys(reasoning, new Set(['context', 'effort', 'summary']), 'reasoning controls');
    if (
      reasoning.effort !== undefined &&
      (typeof reasoning.effort !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(reasoning.effort))
    ) {
      throw new Error('Invalid reasoning effort');
    }
    if (
      reasoning.summary !== undefined &&
      reasoning.summary !== 'auto' &&
      reasoning.summary !== 'concise' &&
      reasoning.summary !== 'detailed' &&
      reasoning.summary !== 'none'
    ) {
      throw new Error('Invalid reasoning summary');
    }
    if (
      reasoning.context !== undefined &&
      reasoning.context !== 'auto' &&
      reasoning.context !== 'current_turn' &&
      reasoning.context !== 'all_turns'
    ) {
      throw new Error('Invalid reasoning context');
    }
  }
  if (value.include !== undefined) {
    if (
      !Array.isArray(value.include) ||
      value.include.length > 1 ||
      value.include.some((entry) => entry !== 'reasoning.encrypted_content')
    ) {
      throw new Error('Unsupported Responses include');
    }
  }
  if (value.client_metadata !== undefined && value.client_metadata !== null) {
    const metadata = object(value.client_metadata, 'client metadata');
    if (Object.keys(metadata).length > 64) throw new Error('Invalid client metadata');
    for (const [key, entry] of Object.entries(metadata)) {
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(key)) throw new Error('Invalid client metadata');
      string(entry, 'client metadata value', 64 * 1024);
    }
  }
  if (value.prompt_cache_key !== undefined) string(value.prompt_cache_key, 'prompt cache key', 1024);
  if (value.service_tier !== undefined) {
    const tier = string(value.service_tier, 'service tier', 64);
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(tier)) throw new Error('Invalid service tier');
  }
  if (value.stream_options !== undefined && value.stream_options !== null) {
    const options = object(value.stream_options, 'stream options');
    exactKeys(options, new Set(['reasoning_summary_delivery']), 'stream options');
    if (options.reasoning_summary_delivery !== 'sequential_cutoff') {
      throw new Error('Invalid stream options');
    }
    throw new Error('Unsupported stream options');
  }
}

function toolOutput(value: unknown): string {
  return string(value, 'tool output');
}

function validateReasoningItem(item: JsonObject): void {
  exactKeys(
    item,
    new Set(['content', 'encrypted_content', 'id', 'internal_chat_message_metadata_passthrough', 'summary', 'type']),
    'reasoning item'
  );
  if (item.id !== undefined) string(item.id, 'reasoning item id', 128);
  if (item.encrypted_content !== undefined && item.encrypted_content !== null) {
    string(item.encrypted_content, 'encrypted reasoning content');
  }
  if (!Array.isArray(item.summary) || item.summary.length > 128) throw new Error('Invalid reasoning summary');
  for (const entry of item.summary) {
    const summary = object(entry, 'reasoning summary');
    exactKeys(summary, new Set(['text', 'type']), 'reasoning summary');
    if (summary.type !== 'summary_text') throw new Error('Invalid reasoning summary');
    string(summary.text, 'reasoning summary text');
  }
  if (item.content !== undefined && item.content !== null) {
    if (!Array.isArray(item.content) || item.content.length > 128) throw new Error('Invalid reasoning content');
    for (const entry of item.content) {
      const content = object(entry, 'reasoning content');
      exactKeys(content, new Set(['text', 'type']), 'reasoning content');
      if (content.type !== 'reasoning_text' && content.type !== 'text') throw new Error('Invalid reasoning content');
      string(content.text, 'reasoning text');
    }
  }
  if (item.internal_chat_message_metadata_passthrough !== undefined) {
    const metadata = object(item.internal_chat_message_metadata_passthrough, 'reasoning metadata');
    exactKeys(metadata, new Set(['turn_id']), 'reasoning metadata');
    if (metadata.turn_id !== undefined) string(metadata.turn_id, 'reasoning turn id', 128);
  }
}

function toolChoice(value: unknown, tools: Map<string, ToolKind>): unknown {
  if (value === undefined) return tools.size > 0 ? 'auto' : undefined;
  if (value === 'auto' || value === 'none' || value === 'required') return value;
  const choice = object(value, 'tool choice');
  exactKeys(choice, new Set(['name', 'type']), 'tool choice');
  const name = string(choice.name, 'tool choice name', 64);
  if (!tools.has(name) || (choice.type !== 'function' && choice.type !== 'custom')) {
    throw new Error('Invalid tool choice');
  }
  return { type: 'function', function: { name } };
}

export function responsesToChatCompletionsRequest(
  value: JsonObject,
  upstreamModelId: string,
  maxTokens: number,
  allowImages: boolean
): ChatCompletionsRequest {
  exactKeys(value, requestKeys, 'Responses request');
  if (value.stream !== true || value.store !== false || !Array.isArray(value.input)) {
    throw new Error('Invalid Responses request');
  }
  validateResponsesControls(value);
  const { responseFormat } = textControls(value.text);
  const { tools, kinds } = chatTools(value.tools);
  const messages: JsonObject[] = [];
  const instructions = value.instructions === undefined ? '' : string(value.instructions, 'instructions');
  if (instructions) messages.push({ role: 'system', content: instructions });
  const callKinds = new Map<string, ToolKind>();
  const seenCallIds = new Set<string>();
  let pendingCalls: JsonObject[] = [];
  const flushCalls = (): void => {
    if (pendingCalls.length === 0) return;
    messages.push({ role: 'assistant', content: null, tool_calls: pendingCalls });
    pendingCalls = [];
  };
  for (const entry of value.input) {
    const item = object(entry, 'input item');
    const type = item.type;
    if (type === 'reasoning') {
      validateReasoningItem(item);
      continue;
    }
    if (type === 'message') {
      flushCalls();
      exactKeys(
        item,
        new Set(['content', 'id', 'internal_chat_message_metadata_passthrough', 'phase', 'role', 'type']),
        'message'
      );
      const role = item.role;
      if (role !== 'user' && role !== 'assistant') throw new Error('Unsupported message role');
      messages.push({ role, content: messageContent(item.content, role, allowImages) });
      continue;
    }
    if (type === 'function_call' || type === 'custom_tool_call') {
      exactKeys(
        item,
        new Set(
          type === 'function_call'
            ? ['arguments', 'call_id', 'id', 'internal_chat_message_metadata_passthrough', 'name', 'namespace', 'type']
            : [
                'call_id',
                'id',
                'input',
                'internal_chat_message_metadata_passthrough',
                'name',
                'namespace',
                'status',
                'type',
              ]
        ),
        'tool call'
      );
      if (item.namespace !== undefined) throw new Error('Unsupported tool namespace');
      const callId = string(item.call_id, 'tool call id', 128);
      const name = string(item.name, 'tool call name', 64);
      const kind = kinds.get(name);
      if (!kind || kind.type !== (type === 'custom_tool_call' ? 'custom' : 'function') || seenCallIds.has(callId)) {
        throw new Error('Invalid tool call');
      }
      seenCallIds.add(callId);
      callKinds.set(callId, kind);
      pendingCalls.push({
        id: callId,
        type: 'function',
        function: {
          name,
          arguments:
            type === 'custom_tool_call'
              ? JSON.stringify({ input: string(item.input, 'custom tool input') })
              : string(item.arguments, 'tool arguments'),
        },
      });
      continue;
    }
    if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      flushCalls();
      exactKeys(
        item,
        new Set(['call_id', 'id', 'internal_chat_message_metadata_passthrough', 'name', 'output', 'type']),
        'tool output'
      );
      const callId = string(item.call_id, 'tool output call id', 128);
      const kind = callKinds.get(callId);
      if (!kind || kind.type !== (type === 'custom_tool_call_output' ? 'custom' : 'function')) {
        throw new Error('Orphan tool output');
      }
      callKinds.delete(callId);
      messages.push({ role: 'tool', tool_call_id: callId, content: toolOutput(item.output) });
      continue;
    }
    throw new Error('Unsupported input item');
  }
  flushCalls();
  if (callKinds.size > 0) throw new Error('Missing tool output');
  if (messages.length === 0) throw new Error('Responses input is empty');
  if (
    value.max_output_tokens !== undefined &&
    (!Number.isSafeInteger(value.max_output_tokens) || Number(value.max_output_tokens) < 1)
  ) {
    throw new Error('Invalid maximum output tokens');
  }
  if (value.parallel_tool_calls !== undefined && typeof value.parallel_tool_calls !== 'boolean') {
    throw new Error('Invalid parallel tool calls');
  }
  const choice = toolChoice(value.tool_choice, kinds);
  return {
    body: JSON.stringify({
      model: upstreamModelId,
      messages,
      ...(tools === undefined ? {} : { tools }),
      ...(choice === undefined ? {} : { tool_choice: choice }),
      ...(value.parallel_tool_calls === undefined ? {} : { parallel_tool_calls: value.parallel_tool_calls }),
      ...(responseFormat === undefined ? {} : { response_format: responseFormat }),
      max_tokens:
        value.max_output_tokens === undefined ? maxTokens : Math.min(Number(value.max_output_tokens), maxTokens),
      stream: true,
      stream_options: { include_usage: true },
    }),
    tools: kinds,
  };
}

type PendingToolCall = {
  id?: string;
  name?: string;
  arguments: string;
};

function sse(type: string, payload: JsonObject): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`Invalid ${label}`);
  return Number(value);
}

function responsesUsage(value: unknown): JsonObject {
  const usage = object(value, 'usage');
  const inputTokens = nonNegativeInteger(usage.prompt_tokens, 'prompt tokens');
  const outputTokens = nonNegativeInteger(usage.completion_tokens, 'completion tokens');
  const totalTokens = nonNegativeInteger(usage.total_tokens, 'total tokens');
  const inputDetails =
    usage.prompt_tokens_details === undefined || usage.prompt_tokens_details === null
      ? {}
      : object(usage.prompt_tokens_details, 'prompt token details');
  const outputDetails =
    usage.completion_tokens_details === undefined || usage.completion_tokens_details === null
      ? {}
      : object(usage.completion_tokens_details, 'completion token details');
  const cachedTokens = nonNegativeInteger(
    inputDetails.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0,
    'cached tokens'
  );
  const cacheWriteTokens = nonNegativeInteger(inputDetails.cache_write_tokens ?? 0, 'cache write tokens');
  const reasoningTokens = nonNegativeInteger(outputDetails.reasoning_tokens ?? 0, 'reasoning tokens');
  if (cachedTokens + cacheWriteTokens > inputTokens || totalTokens !== inputTokens + outputTokens) {
    throw new Error('Invalid token totals');
  }
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: cachedTokens, cache_write_tokens: cacheWriteTokens },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: reasoningTokens },
    total_tokens: totalTokens,
  };
}

function customInput(argumentsText: string): string {
  const value = object(JSON.parse(argumentsText) as unknown, 'custom tool arguments');
  if (Object.keys(value).length !== 1 || typeof value.input !== 'string') {
    throw new Error('Invalid custom tool arguments');
  }
  return string(value.input, 'custom tool input');
}

export function chatCompletionsToResponsesStream(upstream: Response, options: ChatCompletionsStreamOptions): Response {
  if (!upstream.body) throw new Error('Chat completion stream is unavailable');
  const reader = upstream.body.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let pending = '';
      let content = '';
      let messageStarted = false;
      let finishReason: string | undefined;
      let usage: JsonObject | undefined;
      let providerId: string | undefined;
      let reasoning = '';
      let done = false;
      const calls = new Map<number, PendingToolCall>();
      const emit = (value: string): void => controller.enqueue(encoder.encode(value));
      const processData = (data: string): void => {
        if (data === '[DONE]') {
          done = true;
          return;
        }
        const chunk = object(JSON.parse(data) as unknown, 'chat completion chunk');
        if (chunk.object !== undefined && chunk.object !== 'chat.completion.chunk') {
          throw new Error('Invalid chat completion chunk');
        }
        if (typeof chunk.id === 'string') {
          if (providerId !== undefined && providerId !== chunk.id) throw new Error('Mismatched provider response id');
          providerId = string(chunk.id, 'provider response id', 512);
        }
        if (chunk.usage !== undefined && chunk.usage !== null) {
          if (usage !== undefined) throw new Error('Duplicate usage');
          usage = responsesUsage(chunk.usage);
        }
        if (!Array.isArray(chunk.choices)) throw new Error('Invalid chat completion choices');
        if (chunk.choices.length === 0) return;
        if (chunk.choices.length !== 1) throw new Error('Multiple chat completion choices are unsupported');
        const choice = object(chunk.choices[0], 'chat completion choice');
        if (choice.index !== 0) throw new Error('Invalid chat completion choice index');
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          if (
            finishReason !== undefined ||
            (choice.finish_reason !== 'stop' && choice.finish_reason !== 'tool_calls')
          ) {
            throw new Error('Unsupported chat completion finish reason');
          }
          finishReason = choice.finish_reason;
        }
        const delta = object(choice.delta ?? {}, 'chat completion delta');
        exactKeys(delta, new Set(['content', 'reasoning_content', 'role', 'tool_calls']), 'chat completion delta');
        if (delta.role !== undefined && delta.role !== 'assistant') throw new Error('Invalid chat completion role');
        if (delta.reasoning_content !== undefined && delta.reasoning_content !== null) {
          reasoning += string(delta.reasoning_content, 'reasoning content');
        }
        if (delta.content !== undefined && delta.content !== null) {
          const text = string(delta.content, 'chat completion content');
          if (text) {
            if (calls.size > 0) throw new Error('Interleaved content and tool calls are unsupported');
            if (!messageStarted) {
              messageStarted = true;
              emit(
                sse('response.output_item.added', {
                  item: { type: 'message', role: 'assistant', id: `msg-${options.responseId}`, content: [] },
                })
              );
            }
            content += text;
            emit(sse('response.output_text.delta', { delta: text }));
          }
        }
        if (delta.tool_calls !== undefined) {
          if (!Array.isArray(delta.tool_calls)) throw new Error('Invalid tool call delta');
          for (const entry of delta.tool_calls) {
            const call = object(entry, 'tool call delta');
            const index = nonNegativeInteger(call.index, 'tool call index');
            if (index > 63) throw new Error('Too many tool calls');
            const current = calls.get(index) ?? { arguments: '' };
            if (call.id !== undefined && call.id !== null) {
              const id = string(call.id, 'tool call id', 128);
              if (current.id !== undefined && current.id !== id) throw new Error('Mismatched tool call id');
              current.id = id;
            }
            if (call.type !== undefined && call.type !== 'function') throw new Error('Unsupported tool call type');
            if (call.function !== undefined) {
              const fn = object(call.function, 'tool call function');
              if (fn.name !== undefined && fn.name !== null) {
                const name = string(fn.name, 'tool call name', 64);
                if (current.name !== undefined && current.name !== name) throw new Error('Mismatched tool call name');
                current.name = name;
              }
              if (fn.arguments !== undefined && fn.arguments !== null) {
                current.arguments += string(fn.arguments, 'tool call arguments');
                if (current.arguments.length > 1024 * 1024) throw new Error('Tool arguments are too large');
              }
            }
            calls.set(index, current);
          }
        }
      };
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          pending += decoder.decode(next.value, { stream: true });
          const frames = pending.split(/\r?\n\r?\n/);
          pending = frames.pop() ?? '';
          for (const frame of frames) {
            const data = frame
              .split(/\r?\n/)
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n')
              .trim();
            if (data) processData(data);
          }
        }
        pending += decoder.decode();
        if (pending.trim()) {
          const data = pending
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
            .trim();
          if (data) processData(data);
        }
        if (!done || !finishReason || !usage || !providerId) throw new Error('Incomplete chat completion stream');
        if (reasoning && calls.size > 0) throw new Error('Reasoning tool calls are unsupported');
        if (messageStarted) {
          emit(
            sse('response.output_item.done', {
              item: {
                type: 'message',
                role: 'assistant',
                id: `msg-${options.responseId}`,
                content: [{ type: 'output_text', text: content }],
              },
            })
          );
        }
        for (const index of [...calls.keys()].toSorted((left, right) => left - right)) {
          const call = calls.get(index);
          if (!call?.id || !call.name) throw new Error('Incomplete tool call');
          const kind = options.tools.get(call.name);
          if (!kind) throw new Error('Unknown tool call');
          emit(
            sse('response.output_item.done', {
              item:
                kind.type === 'custom'
                  ? {
                      type: 'custom_tool_call',
                      id: `ctc-${options.responseId}-${index}`,
                      call_id: call.id,
                      name: call.name,
                      input: customInput(call.arguments),
                    }
                  : {
                      type: 'function_call',
                      id: `fc-${options.responseId}-${index}`,
                      call_id: call.id,
                      name: call.name,
                      arguments: call.arguments,
                    },
            })
          );
        }
        emit(
          sse('response.completed', {
            response: {
              id: options.responseId,
              status: 'completed',
              end_turn: finishReason === 'stop',
              usage,
            },
          })
        );
        emit('data: [DONE]\n\n');
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

/** Validate the native Chat wire without converting away reasoning/tool history. */
export function nativeChatCompletionsRequest(value: JsonObject, model: string, maxTokens: number, allowImages: boolean, effort?: string): ChatCompletionsRequest {
  exactKeys(value, new Set(['model', 'messages', 'stream', 'stream_options', 'thinking', 'reasoning_effort', 'tools', 'tool_choice', 'parallel_tool_calls', 'temperature', 'max_tokens', 'stop']), 'chat request');
  if (value.stream !== true || !Array.isArray(value.messages) || value.messages.length === 0) throw new Error('Invalid chat request');
  for (const entry of value.messages) {
    const message = object(entry, 'chat message');
    if (!['system', 'user', 'assistant', 'tool'].includes(String(message.role))) throw new Error('Invalid message role');
    exactKeys(message, new Set(['role', 'content', 'reasoning_content', 'tool_calls', 'tool_call_id', 'name']), 'chat message');
    if (Array.isArray(message.content)) {
      if (message.role !== 'user') throw new Error('Invalid content role');
      for (const part of message.content) {
        const item = object(part, 'content part');
        if (item.type === 'text') string(item.text, 'text');
        else if (item.type === 'image_url') {
          if (!allowImages) throw new Error('Image input unavailable');
          string(object(item.image_url, 'image URL').url, 'image URL', 48 * 1024 * 1024);
        }
        else throw new Error('Unsupported content part');
      }
    } else if (!(message.role === 'assistant' && message.content === null)) string(message.content, 'content');
    if (message.reasoning_content !== undefined) {
      if (message.role !== 'assistant') throw new Error('Invalid reasoning role');
      string(message.reasoning_content, 'reasoning content');
    }
    if (message.role === 'tool') string(message.tool_call_id, 'tool call id', 512);
    if (message.tool_calls !== undefined) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) throw new Error('Invalid tool calls');
      for (const entry of message.tool_calls) {
        const call = object(entry, 'tool call');
        if (call.type !== 'function') throw new Error('Invalid tool type');
        string(call.id, 'tool call id', 512);
        const fn = object(call.function, 'tool function');
        string(fn.name, 'tool name', 64); string(fn.arguments, 'tool arguments');
      }
    }
  }
  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools) || value.tools.length > 128) throw new Error('Invalid tools');
    for (const entry of value.tools) {
      const tool = object(entry, 'tool');
      if (tool.type !== 'function') throw new Error('Invalid tool type');
      const fn = object(tool.function, 'tool function');
      if (!toolNamePattern.test(string(fn.name, 'tool name', 64))) throw new Error('Invalid tool name');
      object(fn.parameters, 'tool parameters');
    }
  }
  if (value.max_tokens !== undefined && (!Number.isSafeInteger(value.max_tokens) || Number(value.max_tokens) < 1)) throw new Error('Invalid max tokens');
  if (value.temperature !== undefined && (typeof value.temperature !== 'number' || value.temperature < 0 || value.temperature > 2)) throw new Error('Invalid temperature');
  if (value.stop !== undefined && (!Array.isArray(value.stop) || value.stop.length > 16 || value.stop.some(item => typeof item !== 'string'))) throw new Error('Invalid stop');
  if (value.thinking !== undefined && !['enabled', 'disabled'].includes(String(object(value.thinking, 'thinking').type))) throw new Error('Invalid thinking');
  if (value.reasoning_effort !== undefined && !['low', 'high', 'max'].includes(String(value.reasoning_effort))) throw new Error('Invalid reasoning effort');
  const disabledThinking = value.thinking !== undefined && object(value.thinking, 'thinking').type === 'disabled';
  const { reasoning_effort: _requestedEffort, ...request } = value;
  return { body: JSON.stringify({ ...request, model, stream_options: { include_usage: true }, max_tokens: Math.min(Number(value.max_tokens ?? maxTokens), maxTokens),
    ...(disabledThinking ? {} : effort ? { thinking: { type: 'enabled' }, reasoning_effort: effort } : value.reasoning_effort === undefined ? {} : { reasoning_effort: value.reasoning_effort }),
  }), tools: new Map() };
}

/** Only normalize accounting metadata; native Chat chunks remain byte-for-byte on the wire. */
export function chatCompletionUsageEvent(value: unknown): JsonObject | undefined {
  const chunk = object(value, 'chat completion chunk');
  if (chunk.error !== undefined) throw new Error('Upstream chat completion failed');
  if (chunk.object !== 'chat.completion.chunk' || !Array.isArray(chunk.choices) || chunk.choices.length > 1) throw new Error('Invalid chat completion chunk');
  string(chunk.id, 'provider response id', 512);
  if (chunk.choices.length === 1 && object(chunk.choices[0], 'chat choice').index !== 0) throw new Error('Invalid chat choice index');
  if (chunk.usage === undefined || chunk.usage === null) return undefined;
  return { type: 'response.completed', response: { id: string(chunk.id, 'provider response id', 512), status: 'completed', usage: responsesUsage(chunk.usage) } };
}
