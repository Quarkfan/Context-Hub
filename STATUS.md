# Context Hub 当前状态

最后更新：2026-08-15

## 仓库定位

本仓库是 Context Hub（CH，上下文中心）的独立仓库，父项目 `QuarkfanTools` 通过 submodule 引用。当前阶段以文档和合同为事实来源，后续实现可以先在单机版内落 facade，再逐步迁移到本仓库。

## 当前事实来源

新 session 按顺序阅读：

1. `AGENTS.md`
2. `docs/context-hub.md`
3. `docs/implementation-blueprint.md`

父项目的中心边界、跨中心协议、参考矩阵、参考项目评估和 macOS/Linux 蓝图保存在父项目 `docs/` 与 `Reference-Projects/` 下；CH 仓库只保留 CH 自己的设计和实现合同。

## 已完成

- CH 正式命名为 Context Hub，简称 CH。
- 明确 CH 不只是知识库，也承担系统级记忆模块职责，包括短期记忆、中期记忆和长期记忆。
- 建立 `ContextSource`、`ContextCollection`、`ContextRecord`、`ContextMemory`、`ContextScope`、`ContextRetriever`、`ContextMemoryWriter` 等核心概念。
- 明确 CH 与 MG、运行时中心、工具与能力中心、模型中心、资源中心、调度与系统基础中心、治理与安全中心的边界。
- 建立 P0 范围：只读接入 Skill `knowledge/`、只读接入受控飞书文件/文档缓存引用、会话摘要作为中期记忆候选、手工确认长期记忆、基础关键词检索、freshness/scope/audit 字段和每 Bot 授权过滤。
- 建立可执行设计蓝图：P0 DTO、模块边界、存储布局、管理面 API、source 入库、上下文召回、记忆候选/确认/遗忘、适配器合同、UI 可见性、清理策略、迁移阶段、测试矩阵和验收标准。
- 完成第一轮知识/RAG 参考项目评估：AnythingLLM、Open WebUI、Dify、LlamaIndex。评估记录保存在父项目 `Reference-Projects/evaluations/context-hub/`。
- 完成 TencentDB Agent Memory 第一轮源码级评估。评估记录保存在父项目 `Reference-Projects/evaluations/context-hub/tencentdb-agent-memory-first-pass.md`。
- 吸收 TencentDB Agent Memory 中适合 CH 的结构：Bot Loadout / `ContextBinding`、L0-L3 派生层的中性表达、query-only knowledge tools、检索后 scope/policy 二次复核、memory generation trace 和 injection hint。
- 记录后续 memory 参考建议：Mem0 / OpenMemory、Letta、Zep / Graphiti、LangGraph / LangMem。

## 下一步建议

1. 补充 Mem0 / OpenMemory、Letta、Zep / Graphiti、LangGraph / LangMem 源码级评估，重点看用户记忆、agent memory、temporal graph memory、checkpoint memory、记忆删除和冲突处理。
2. 在单机版 `QuarkfanTools-Single/` 内先建立 `ContextHub` facade，不急于拆独立进程。
3. 将现有 Skill knowledge、受控飞书缓存、会话摘要、Bot 授权和 runtime context 注入路径映射到 CH P0 合同。
4. 按蓝图落 CH 管理面可见性：source list、Bot loadout、fresh/stale、index status、memory candidates、generation trace、confirmed memories、recall test、used context trace、forget/audit。
5. 为 source、binding、ingestion、retrieval、memory、cleanup 和 diagnostics 建合同测试。

## 验证

当前仓库暂无构建命令。文档阶段常规验证：

```bash
git diff --check
```
