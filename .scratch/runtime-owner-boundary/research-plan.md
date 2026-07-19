# Research Plan: Server 与 Runtime 的隔离及复用边界

> Core question: Server 是否应只下发用户选择的隔离级别与业务身份事实，并由 Runtime 自主推导 worker 复用键和执行生命周期；当前实现在哪些位置越过了这条边界。
> min_rounds: 2

## Dimensions

1. 用户配置与业务语义——确认用户实际选择的是什么，以及 Workspace 应持久化哪些事实。
2. Server placement 职责——确认 RunLauncher 当前计算并下发了哪些执行面决策。
3. Runtime worker 复用——确认 Runtime 当前如何取得、复用、索引及停止 worker。
4. 生命周期清理——确认 workspace 删除、user 注销、Host 重连对账需要哪些输入。
5. 协议与插件边界——确认 shared 协议和 runtime-sdk 是否泄漏了 Runtime 内部复用模型。
6. 迁移影响——列出类型、接口、调用方、测试和文档的最小一致修改面。

## Completion criteria

- [ ] 每个维度至少从两条独立代码路径或文档/测试证据验证。
- [ ] 明确区分业务事实、Server placement 决策和 Runtime 内部派生状态。
- [ ] 用 workspace-scope、user-scope、跨 runtimeType、删除/注销四类场景检验目标模型。
- [ ] 给出可实施的目标契约、修改文件范围、迁移顺序与验收标准。
- [ ] 两轮探索完成后由独立验证者给出 PASS。

## Scope

- In: Workspace 隔离配置、RunPlacement、OwnerKey/WorkerKey、RuntimeHost 生命周期契约、Runtime worker pool、runtime-sdk provider 输入、相关测试与目标架构文档。
- Out: 业务资源的 RBAC owner 校验、RuntimeHost 数据库记录的注册者 ownerId、实际编码实现、build/lint/浏览器测试。
