import { describe, expect, it } from 'vitest'
import {
  isPlaygroundChatInput,
  isPlaygroundModelsInput,
  PLAYGROUND_LIMITS,
  projectPlaygroundChat,
  projectPlaygroundModels,
} from '../../packages/contracts/playground'

const identity = { projectId: 'project', apiKey: 'sk-nx-fixture-key-01234567890123456789' }
const input = { ...identity, model: 'fixture-model', messages: [{ role: 'user', content: 'Hello' }], maxTokens: 32 }
const reply = (message: Record<string, unknown> = { role: 'assistant', content: 'Hello' }, finish = 'stop') => ({
  object: 'chat.completion',
  model: 'fixture-model',
  choices: [{ index: 0, message, finish_reason: finish }],
})

describe('Playground transient contract', () => {
  it('accepts only an explicit project Key and bounded alternating text conversation', () => {
    expect(isPlaygroundModelsInput(identity)).toBe(true)
    expect(isPlaygroundChatInput(input)).toBe(true)
    expect(
      isPlaygroundChatInput({
        ...input,
        messages: [...input.messages, { role: 'assistant', content: 'Reply' }, { role: 'user', content: 'Next' }],
      }),
    ).toBe(true)
  })
  it.each(['stream', 'temperature', 'tools', 'system', 'channelId', 'url', 'requestId', 'headers'])(
    'rejects %s rather than silently dropping caller extensions',
    (field) => {
      expect(isPlaygroundChatInput({ ...input, [field]: null })).toBe(false)
      expect(isPlaygroundModelsInput({ ...identity, [field]: null })).toBe(false)
    },
  )
  it.each([
    null,
    [],
    '',
    {},
    { ...input, apiKey: 'x' },
    { ...input, projectId: 'bad\nproject' },
    { ...input, model: '' },
    { ...input, maxTokens: 0 },
    { ...input, maxTokens: 8193 },
    { ...input, maxTokens: 1.5 },
    { ...input, messages: [] },
    { ...input, messages: [{ role: 'system', content: 'x' }] },
    { ...input, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] },
    { ...input, messages: [{ role: 'user', content: 'x', refusal: null }] },
    { ...input, messages: [{ role: 'assistant', content: 'x' }] },
    {
      ...input,
      messages: [
        { role: 'user', content: 'x' },
        { role: 'user', content: 'x' },
      ],
    },
    { ...input, messages: [{ role: 'user', content: ' ' }] },
  ])('rejects invalid request %#', (value) => {
    expect(isPlaygroundChatInput(value)).toBe(false)
  })
  it('enforces the message/output caps', () => {
    const messages = Array.from({ length: 63 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: 'x',
    }))
    expect(isPlaygroundChatInput({ ...input, messages, maxTokens: PLAYGROUND_LIMITS.outputTokens })).toBe(true)
    expect(
      isPlaygroundChatInput({
        ...input,
        messages: [...messages, { role: 'assistant', content: 'x' }, { role: 'user', content: 'x' }],
      }),
    ).toBe(false)
  })
  it('projects model IDs without upstream metadata or duplicate identity', () => {
    expect(
      projectPlaygroundModels(
        { object: 'list', data: [{ id: 'model', credential: 'private' }], internal: 'private' },
        'request',
      ),
    ).toEqual({ version: 1, models: [{ id: 'model' }], requestId: 'request' })
    expect(() => projectPlaygroundModels({ object: 'list', data: [{ id: 'model' }, { id: 'model' }] }, null)).toThrow()
  })
  it('preserves independent exact, zero and unknown reported usage', () => {
    const result = projectPlaygroundChat(
      {
        ...reply(),
        usage: {
          prompt_tokens: '9007199254740993',
          completion_tokens: 0,
          prompt_tokens_details: { cached_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: null },
        },
        private: 'private',
      },
      'real-request',
    )
    expect(result.usage).toEqual({
      inputTokens: '9007199254740993',
      outputTokens: '0',
      cachedInputTokens: '0',
      reasoningTokens: null,
      totalTokens: null,
    })
    expect(result.canContinue).toBe(true)
    expect(JSON.stringify(result)).not.toContain('private')
    expect(projectPlaygroundChat(reply(), null).usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
    })
  })
  it.each([undefined, null, '', [], {}])('any present semantic field (%j) prevents a stripped replay', (value) => {
    for (const field of [
      'refusal',
      'tool_calls',
      'function_call',
      'reasoning',
      'reasoning_content',
      'reasoning_details',
      'audio',
      'annotations',
      'unknown_state',
    ]) {
      const message = { role: 'assistant', content: 'visible', [field]: value }
      if (field === 'refusal' && value !== null && typeof value !== 'string')
        expect(() => projectPlaygroundChat(reply(message), null)).toThrow()
      else expect(projectPlaygroundChat(reply(message), null).canContinue).toBe(false)
    }
  })
  it('preserves empty refusal and explicitly blocks empty/truncated replies', () => {
    expect(projectPlaygroundChat(reply({ role: 'assistant', content: null, refusal: '' }), null)).toMatchObject({
      assistant: { content: null, refusal: '' },
      canContinue: false,
    })
    expect(projectPlaygroundChat(reply({ role: 'assistant', content: '' }), null).canContinue).toBe(false)
    expect(projectPlaygroundChat(reply(undefined, 'length'), null).canContinue).toBe(false)
    expect(projectPlaygroundChat(reply(undefined, 'content_filter'), null).canContinue).toBe(false)
    expect(projectPlaygroundChat(reply(undefined, 'future_finish_reason'), null).canContinue).toBe(false)
  })
  it('shows tool-only/refusal-only replies with omitted visible content and prevents continuation', () => {
    expect(projectPlaygroundChat(reply({ role: 'assistant', tool_calls: [] }, 'tool_calls'), null)).toMatchObject({
      assistant: { content: null, refusal: null },
      canContinue: false,
    })
    expect(projectPlaygroundChat(reply({ role: 'assistant', refusal: 'Visible refusal' }), null)).toMatchObject({
      assistant: { content: null, refusal: 'Visible refusal' },
      canContinue: false,
    })
    expect(() => projectPlaygroundChat(reply({ role: 'assistant' }), null)).toThrow()
  })
  it.each([
    null,
    {},
    { ...reply(), choices: [] },
    { ...reply(), choices: [reply().choices[0], reply().choices[0]] },
    reply({ role: 'user', content: 'x' }),
    reply({ role: 'assistant', content: [{ type: 'text', text: 'x' }] }),
    { ...reply(), usage: { prompt_tokens: -1 } },
    { ...reply(), usage: { total_tokens: 9007199254740992 } },
    { ...reply(), usage: { total_tokens: '1.5' } },
    { ...reply(), usage: { prompt_tokens_details: [] } },
  ])('rejects malformed 2xx envelopes %#', (value) => {
    expect(() => projectPlaygroundChat(value, null)).toThrow('Invalid Playground response')
  })
})
