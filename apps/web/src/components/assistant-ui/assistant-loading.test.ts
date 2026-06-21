import { describe, it, expect } from 'vitest';
import { getAssistantStage, type AssistantStageMessage } from './assistant-loading';

function assistant(
  parts: AssistantStageMessage['parts'] = [],
  status: { type: string } = { type: 'running' },
): AssistantStageMessage {
  return { role: 'assistant', status, parts };
}

describe('getAssistantStage', () => {
  describe('非运行状态返回 null', () => {
    it('非 assistant 消息返回 null', () => {
      expect(getAssistantStage({ role: 'user', status: { type: 'running' } })).toBeNull();
    });

    it('消息未运行（complete）返回 null', () => {
      expect(getAssistantStage(assistant([], { type: 'complete' }))).toBeNull();
    });

    it('消息已取消（incomplete）返回 null', () => {
      expect(getAssistantStage(assistant([], { type: 'incomplete' }))).toBeNull();
    });

    it('消息无 status 返回 null', () => {
      expect(getAssistantStage({ role: 'assistant', parts: [] })).toBeNull();
    });
  });

  describe('运行中按末段 part 判定阶段', () => {
    it('无 part（消息初始）→ 思考中', () => {
      expect(getAssistantStage(assistant([]))).toBe('thinking');
    });

    it('reasoning 流式（running）→ 思考中', () => {
      expect(
        getAssistantStage(assistant([{ type: 'reasoning', status: { type: 'running' } }])),
      ).toBe('thinking');
    });

    it('text 流式（running）→ 回复中', () => {
      expect(getAssistantStage(assistant([{ type: 'text', status: { type: 'running' } }]))).toBe(
        'replying',
      );
    });

    it('text 已完成（段间空隙）→ 思考中', () => {
      expect(getAssistantStage(assistant([{ type: 'text', status: { type: 'complete' } }]))).toBe(
        'thinking',
      );
    });

    it('tool-call 运行中（running）→ 执行中', () => {
      expect(
        getAssistantStage(assistant([{ type: 'tool-call', status: { type: 'running' } }])),
      ).toBe('executing');
    });

    it('tool-call 等待确认（requires-action）→ 执行中', () => {
      expect(
        getAssistantStage(
          assistant([{ type: 'tool-call', status: { type: 'requires-action' } }]),
        ),
      ).toBe('executing');
    });

    it('tool-call 已完成（段间空隙）→ 思考中', () => {
      expect(
        getAssistantStage(assistant([{ type: 'tool-call', status: { type: 'complete' } }])),
      ).toBe('thinking');
    });

    it('未知 part 类型（data/file 等）→ 思考中', () => {
      expect(getAssistantStage(assistant([{ type: 'data', status: { type: 'running' } }]))).toBe(
        'thinking',
      );
    });
  });

  describe('只看最后一个 part', () => {
    it('reasoning 完成后 text 正在流式 → 回复中', () => {
      expect(
        getAssistantStage(
          assistant([
            { type: 'reasoning', status: { type: 'complete' } },
            { type: 'text', status: { type: 'running' } },
          ]),
        ),
      ).toBe('replying');
    });

    it('text 完成后 tool-call 正在执行 → 执行中', () => {
      expect(
        getAssistantStage(
          assistant([
            { type: 'text', status: { type: 'complete' } },
            { type: 'tool-call', status: { type: 'running' } },
          ]),
        ),
      ).toBe('executing');
    });

    it('最后一个 part 无 status 字段 → 思考中', () => {
      expect(getAssistantStage(assistant([{ type: 'text' }]))).toBe('thinking');
    });
  });
});
