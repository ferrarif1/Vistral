# 本地准备指南（中文版）

当前仓库处于“产品合同 + 协作基线”阶段。

## 1）前置条件
- Git
- POSIX shell 环境
- 任意编辑器/IDE

## 2）克隆仓库
```bash
git clone <your-fork-or-origin-url>
cd Vistral
```

## 3）编码前阅读顺序
1. `README.md`
2. `AGENTS.md`
3. `.codex/config.toml`
4. `docs/prd.md`
5. `docs/ia.md`
6. `docs/flows.md`
7. `docs/data-model.md`
8. `docs/api-contract.md`

## 4）最小基线检查
文档改动至少执行：
```bash
rg "docs/setup.md|docs/contributing.md" README.md
```

并手动确认你修改到的链接都指向仓库内真实路径。

## 5）范围提醒
除非任务明确要求，不进入具体业务页面开发。
优先处理协作基建、合同一致性与最小验证。
