# EnvConfig 两层分离：detected（runtime 上报）与 override（admin 覆盖）独立存储

最初设计把 CLI 路径来源和路径本身合并成单层结构（`{ path, source: "custom" | "runtime" | "missing" }`），
一个字段同时编码"路径来自哪"和"是否找到"。但这会让 admin 覆盖直接覆写 runtime 上报的检测值，
清空覆盖后无法自动回退——因为原始检测值已经被覆盖掉了。

决定：DB 上加两个独立 JSON 列。`envConfig` 只存 runtime manager 上报的自动检测结果
（`{ claude: { executablePath, version, authAvailable }, codex: {...}, detectedAt }`），
`envConfigOverride` 只存 admin 手动覆盖（`{ claude?: { executablePath }, codex?: { executablePath } }`）。
`source`（`"system" | "custom"`）不持久化，展示时实时算：override 有值 → custom，否则 → system，
resolvedPath 为 null 即没找到。

## Consequences

- Runtime 上报检测值不会因 admin 覆盖而丢失，admin 清空覆盖后自动回退到 detected 值。
- `source` 是纯派生值，不需要在写入时维护一致性。
- per-runtime per-agent 覆盖粒度自然落地：override 对象里缺某个 agent 的 key 就是不覆盖它。
- 需要两个 DB 列而非一个，但都是 nullable Json，migration 简单。
