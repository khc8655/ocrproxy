# ocrproxy 后端调度器与适配器重构架构标准 (v1.0)

## 1. 核心设计原则

1. **预算与超时分层解耦 (Budget Decoupling)**：
   - 单请求预算必须按业务请求类型动态计算：
     $$\text{endpoint\_budget} = \text{clamp}(\text{single\_timeout} \times \min(\text{max\_retries}, \text{num\_cands}) + 5.0, \text{min\_sec}, 600.0)$$
   - 全局设置 `request_total_budget_sec` 仅作为最高安全上限（Cap），不再作为固定的截断值；
   - 彻底废除 `has_explicit_budget` 引起的死代码逻辑，确保 OCR 与 KB 在多候选场景下拥有充分的重试和故障转移时间。

2. **三级精准故障冷却体系 (Three-Tier Cooldown Hierarchy)**：
   - **Key 级别 (Key-Level: `provider:key`)**：
     - 适用场景：401 (Key 凭据无效)、403 (账户被封)、402 / 欠费 / Quota 耗尽。
     - 效果：直接封锁该 Key，该 Key 下绑定的所有模型与候选在冷却期内一律跳过。
   - **模型级别 (Model-Level: `provider:key:model`)**：
     - 适用场景：404 (上游模型不存在)、410 (模型已永久下线)、422 (该模型不支持当前参数)。
     - 效果：仅隔离该模型映射，不影响该 Key 访问其他正常模型。
   - **供应商级别 (Provider-Level: `provider`)**：
     - 适用场景：502 / 503 / 504 / 网关连接超时。
     - 效果：单次请求内优先跳过该厂商名下其他候选，快速尝试备用厂商。

3. **Sticky 会话复合键一致性**：
   - 统一存储为 `provider:key` 复合键，匹配时严格比对 `cand["provider"] == prov and cand["key"] == key`；
   - 彻底杜绝不同厂商拥有同名 Key（如 `default`, `k1`）时的指针漂移。

4. **Quota 关键词精准化**：
   - 剔除 `"0"`, `"low"` 等单一字符匹配，采用完整短语匹配（`insufficient balance`, `balance is 0`, `balance=0`, `credit balance is too low`, `余额不足`）；
   - 严禁任何正常的错误体因为包含 `"0"`（如时间戳、状态码、trace id）被误判为欠费打入 30 分钟冷宫。

5. **RPM 滑动窗口安全退避**：
   - `_rpm_mark_exhausted` 遭遇 429 时，严禁使用历史最老记录 `w[0]` 填充；
   - 必须保守阻塞 `max(剩余窗口秒数, 15.0)` 或完整 60 秒，防止 1 秒后瞬间放行再次引发雷暴。

6. **向量与重排零拷贝 (Zero-Copy for Embeddings & Rerank)**：
   - `/v1/embeddings` 与 `/v1/rerank` 直接以 `Response(content=sr.raw_content, media_type="application/json")` 返回原始字节；
   - 彻底消除几百万个 Python float 小对象的创建与序列化开销，彻底杜绝 `pymalloc` 内存碎片化导致的不可逆 RSS 增长。

7. **EdgeOne 运行时轻量化与冷却激活**：
   - 在 `completions.js` / `messages.js` 统一接入 `classifyFailure` 与 `setCooldown`；
   - 增加 900KB 请求体准入防护；
   - 首包前侦测带内错误，支持平滑换 Key。
