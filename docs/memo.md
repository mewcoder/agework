# Memo

## Agent Run 调用链路

```
用户输入消息
  → assistant-ui（useAgUiRuntime）
      → HttpAgent.run(params)          @ag-ui/client
          → prepareRunAgentInput()
              → runId = uuid.v4()      自动生成
          → HTTP POST /api/v1/agent/run
              → AgentController.run()
                  → AgentService.getAdapter()
                      → CodexAgentAdapter / ClaudeAgentAdapter
                          → SSE 流式返回事件
```
