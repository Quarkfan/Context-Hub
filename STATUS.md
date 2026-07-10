# Context Hub 当前状态

最后更新：2026-07-10

## 仓库定位

本仓库是 Context Hub（CH，上下文中心）的独立仓库，父项目 `QuarkfanTools` 通过 submodule 引用。当前阶段以文档和合同为事实来源，后续实现可以先在单机版内落 facade，再逐步迁移到本仓库。

## 当前事实来源

新 session 按顺序阅读：

1. `AGENTS.md`
2. `docs/context-hub.md`

父项目的中心边界、跨中心协议、参考矩阵、参考项目评估和 macOS/Linux 蓝图保存在父项目 `docs/` 与 `Reference-Projects/` 下；CH 仓库只保留 CH 自己的设计和实现合同。

## 已完成

- CH 正式命名为 Context Hub，简称 CH。
- 明确 CH 不只是知识库，也承担系统级记忆模块职责，包括短期记忆、中期记忆和长期记忆。
- 建立 `ContextSource`、`ContextCollection`、`ContextRecord`、`ContextMemory`、`ContextScope`、`ContextRetriever`、`ContextMemoryWriter` 等核心概念。
- 明确 CH 与 MG、运行时中心、工具与能力中心、模型中心、资源中心、调度与系统基础中心、治理与安全中心的边界。
- 建立 P0 范围：只读接入 Skill `knowledge/`、只读接入受控飞书文件/文档缓存引用、会话摘要作为中期记忆候选、手工确认长期记忆、基础关键词检索、freshness/scope/audit 字段和每 Bot 授权过滤。
- 完成第一轮知识/RAG 参考项目评估：AnythingLLM、Open WebUI、Dify、LlamaIndex。评估记录保存在父项目 `Reference-Projects/evaluations/context-hub/`。
- 记录第二轮 memory 参考建议：Mem0 / OpenMemory、Letta、Zep / Graphiti、LangGraph / LangMem。

## 下一步建议

1. 补充第二批 memory 项目源码级评估，重点看用户记忆、agent memory、temporal graph memory、checkpoint memory、记忆删除和冲突处理。
2. 基于 `docs/context-hub.md` 继续拆出可执行 P0 合同文档，明确 DTO、状态机、存储布局、API、测试矩阵和迁移路径。
3. 在单机版 `QuarkfanTools-Single/` 内先建立 `ContextHub` facade，不急于拆独立进程。
4. 将现有 Skill knowledge、受控飞书缓存、会话摘要、Bot 授权和 runtime context 注入路径映射到 CH P0 合同。
5. 设计 CH 管理面可见性：source list、fresh/stale、index status、memory candidates、confirmed memories、recall test、used context trace、forget/audit。

## 验证

当前仓库暂无构建命令。文档阶段常规验证：

```bash
git diff --check
```
