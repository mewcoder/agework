import { beforeEach, describe, it, expect } from 'vitest';
import type { RunAgentInput } from '@ag-ui/client';
import { useSelectionStore } from '@/stores/selection-store';
import { extractRunMessageText, createFallbackTitle, withRunSettings, extractFileMentions, withFileMentions } from './agent-run-interceptor';

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

describe('extractFileMentions', () => {
  const knownFiles = new Set(['src/foo.ts', 'apps/web/src/main.tsx', 'README.md']);

  it('提取存在的 @path', () => {
    const paths = extractFileMentions('看看 @src/foo.ts 这个文件', knownFiles);
    expect(paths).toEqual(['src/foo.ts']);
  });

  it('行首 @ 也匹配', () => {
    const paths = extractFileMentions('@README.md 是文档', knownFiles);
    expect(paths).toEqual(['README.md']);
  });

  it('邮箱不误匹配（@ 前非空白）', () => {
    const paths = extractFileMentions('联系 foo@bar.com', knownFiles);
    expect(paths).toEqual([]);
  });

  it('不存在的路径被过滤', () => {
    const paths = extractFileMentions('看看 @nonexistent.ts', knownFiles);
    expect(paths).toEqual([]);
  });

  it('多个 @path 全部提取', () => {
    const paths = extractFileMentions(
      '对比 @src/foo.ts 和 @apps/web/src/main.tsx',
      knownFiles,
    );
    expect(paths).toEqual(['src/foo.ts', 'apps/web/src/main.tsx']);
  });

  it('重复 @path 去重', () => {
    const paths = extractFileMentions(
      '@src/foo.ts 和 @src/foo.ts',
      knownFiles,
    );
    expect(paths).toEqual(['src/foo.ts']);
  });
});

describe('withFileMentions', () => {
  const knownFiles = new Set(['src/foo.ts', 'README.md']);

  it('将 @path 注入 context', () => {
    const input = {
      messages: [
        { role: 'user', content: '看看 @src/foo.ts' },
      ],
      context: [{ description: 'system', value: 'system prompt' }],
    } as unknown as RunAgentInput;

    const result = withFileMentions(input, knownFiles);

    expect(result.context).toEqual([
      { description: 'system', value: 'system prompt' },
      { description: 'mentioned-file', value: 'src/foo.ts' },
    ]);
  });

  it('无 @path 时不修改 context', () => {
    const input = {
      messages: [{ role: 'user', content: '普通消息' }],
      context: [{ description: 'system', value: 'system prompt' }],
    } as unknown as RunAgentInput;

    const result = withFileMentions(input, knownFiles);
    expect(result.context).toEqual([
      { description: 'system', value: 'system prompt' },
    ]);
  });

  it('knownFiles 为空时直接返回原 input', () => {
    const input = {
      messages: [{ role: 'user', content: '@src/foo.ts' }],
      context: [],
    } as unknown as RunAgentInput;

    const result = withFileMentions(input, undefined);
    expect(result).toBe(input);
  });

  it('不存在的 @path 不注入', () => {
    const input = {
      messages: [{ role: 'user', content: '@nonexistent.ts' }],
      context: [],
    } as unknown as RunAgentInput;

    const result = withFileMentions(input, knownFiles);
    expect(result.context).toEqual([]);
  });
});
