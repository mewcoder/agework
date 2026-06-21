import { beforeEach, describe, it, expect } from 'vitest';
import type { RunAgentInput } from '@ag-ui/client';
import { useSelectionStore } from '@/stores/selection-store';
import { extractRunMessageText, createFallbackTitle, withRunSettings } from './agent-run-interceptor';

describe('extractRunMessageText', () => {
  it('字符串直接返回', () => {
    expect(extractRunMessageText('hello')).toBe('hello');
  });

  it('提取 contentPart 数组中的 text', () => {
    const content = [
      { type: 'text', text: 'hello' },
      { type: 'image', url: 'https://example.com/img.png' },
      { type: 'text', text: 'world' },
    ];

    expect(extractRunMessageText(content)).toBe('hello world');
  });

  it('忽略不含 text 属性的部分', () => {
    const content = [
      { type: 'text', text: 'hello' },
      { type: 'tool_call' },
    ];

    expect(extractRunMessageText(content)).toBe('hello');
  });

  it('非字符串非数组返回空字符串', () => {
    expect(extractRunMessageText(42)).toBe('');
    expect(extractRunMessageText(null)).toBe('');
    expect(extractRunMessageText({ foo: 'bar' })).toBe('');
  });

  it('空数组返回空字符串', () => {
    expect(extractRunMessageText([])).toBe('');
  });
});

describe('createFallbackTitle', () => {
  it('从最后一条 user 消息生成标题', () => {
    const input = {
      messages: [
        { role: 'user', content: '帮我写一个 React 组件' },
        { role: 'assistant', content: '好的...' },
        { role: 'user', content: '再加上 TypeScript 支持' },
      ],
    };

    const title = createFallbackTitle(input as unknown as RunAgentInput);

    expect(title).toBe('再加上 TypeScript 支持');
  });

  it('截断超过 40 个字符的内容', () => {
    const input = {
      messages: [
        { role: 'user', content: '请帮我分析一下这个项目的架构设计思路并且给出优化建议' },
      ],
    };

    const title = createFallbackTitle(input as unknown as RunAgentInput);

    expect(title!.length).toBeLessThanOrEqual(40);
  });

  it('没有 user 消息时返回 undefined', () => {
    const input = {
      messages: [
        { role: 'assistant', content: 'hello' },
      ],
    };

    const title = createFallbackTitle(input as unknown as RunAgentInput);

    expect(title).toBeUndefined();
  });

  it('user 消息内容为空时返回 undefined', () => {
    const input = {
      messages: [
        { role: 'user', content: '' },
      ],
    };

    const title = createFallbackTitle(input as unknown as RunAgentInput);

    expect(title).toBeUndefined();
  });

  it('messages 不是数组时返回 undefined', () => {
    const input = { messages: null };

    const title = createFallbackTitle(input as unknown as RunAgentInput);

    expect(title).toBeUndefined();
  });

  it('清理末尾标点符号', () => {
    const input = {
      messages: [
        { role: 'user', content: '请帮我分析一下。' },
      ],
    };

    const title = createFallbackTitle(input as unknown as RunAgentInput);

    expect(title!.endsWith('。')).toBe(false);
  });

  it('contentPart 数组中的 text 拼接后生成标题', () => {
    const input = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '分析一下' },
            { type: 'text', text: '这个项目' },
          ],
        },
      ],
    };

    const title = createFallbackTitle(input as unknown as RunAgentInput);

    expect(title).toBe('分析一下 这个项目');
  });
});

describe('withRunSettings', () => {
  beforeEach(() => {
    useSelectionStore.setState({
      selectedModelProviderIds: {},
      selectedModelByProviderIds: {},
      modelReasoningEffort: 'medium',
      codexPermissionMode: 'auto-review',
    });
  });

  it('透传当前 provider 下选择的具体模型', () => {
    useSelectionStore.setState({
      selectedModelProviderIds: { codex: 'mp-1' },
      selectedModelByProviderIds: { 'mp-1': 'gpt-5' },
      modelReasoningEffort: 'high',
      codexPermissionMode: 'auto-review',
    });

    const input = withRunSettings(
      { messages: [] } as unknown as RunAgentInput,
      'conversation-1',
      'codex',
      useSelectionStore.getState(),
    );

    expect(input.forwardedProps).toMatchObject({
      agentType: 'codex',
      modelProviderId: 'mp-1',
      model: 'gpt-5',
      modelReasoningEffort: 'high',
    });
  });
});
