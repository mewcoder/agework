# ADR-0001: stop 后运行状态乐观写 + 延迟单次校准,不立即 invalidate

日期:2026-07-11
状态:已采纳

## 背景

后端 `POST /agent/stop` 返回时只把 run 标成 `cancelling` 并向 worker 下发取消;conversation 真正落 `idle` 要等 worker 取消回流后异步落库,窗口最长约一两秒。

前端停止运行后曾经的写法:乐观写 `idle` → 立即 `invalidateQueries` → `setTimeout(1500)` 再 invalidate 一次。立即 refetch 会在窗口期拉回仍是 `running` 的旧值,把乐观 `idle` 冲掉,UI 出现 idle→running→idle 闪变;1500ms 的第二次 invalidate 是给这个闪变收尾的无名 hack。

## 决策

`conversations-cache.ts` 提供 `setConversationRunStatusOptimistic(qc, id, status, { revalidateAfterMs })`:**只做乐观写 + 延迟一次 invalidate 校准权威值,不立即刷新**。stop 路径用 `revalidateAfterMs: 1500`。

## 后果

- UI 不再闪变;窗口期内以乐观值为准,权威值由延迟校准 + 5s 轮询兜底。
- 不要"顺手优化"成立即 invalidate——那正是被移除的 bug。
- 若后端将来把 stop 改成同步等待终态落库,这个延迟可以删,届时删函数而不是把延迟调成 0。
