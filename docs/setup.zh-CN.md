# 本地准备指南（中文版）

## 1）前置条件
- Git
- POSIX shell 环境
- 任意编辑器/IDE
- Node.js 20+
- npm 10+

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

## 4）本地开发
```bash
npm install
npm run dev
```

打开：`http://127.0.0.1:5173`

## 5）Docker 内网部署
```bash
cp .env.example .env
docker compose up --build -d
```

打开：`http://127.0.0.1:8080`

若部署机不能本地 build 或无法访问 Docker Hub，可使用预构建镜像模式：
```bash
docker compose -f docker-compose.registry.yml up -d
```

常用部署辅助命令：
```bash
npm run docker:images:build
npm run docker:images:build-push
npm run docker:images:save
IMAGE_TAR=vistral-images-round1.tar npm run docker:images:load-up
npm run docker:healthcheck
npm run docker:verify:full
npm run docker:release:bundle
VERIFY_BASE_URL=http://127.0.0.1:8080 npm run docker:release:bundle:verified
npm run smoke:admin:verification-reports
npm run smoke:demo:train-data
```

`docker:verify:full` 会在 `.data/verify-reports/` 生成验收报告。
`docker:release:bundle` 支持可选约束：
- `VERIFY_REPORT_PATH=<report.json|report.md>` 指定要打包的验收报告
- `VERIFY_REPORT_MAX_AGE_SECONDS=<秒>` 对报告时效做硬校验，超时即失败

## 6）最小基线检查
文档改动至少执行：
```bash
rg "docs/setup.md|docs/contributing.md" README.md
```

并手动确认你修改到的链接都指向仓库内真实路径。

代码改动至少执行：
```bash
npm run typecheck
npm run lint
npm run build
```

## 7）Demo 数据集导入（列车图片）
可直接使用 `demo_data/train` 本地图片快速构建 detection 数据集（mock）：
```bash
npm run smoke:demo:train-data
```

可选参数：
- `MAX_FILES=120 npm run smoke:demo:train-data` 限制导入文件数量（`0` 表示导入全部）
- `START_API=false BASE_URL=http://127.0.0.1:8080 npm run smoke:demo:train-data` 复用已启动 API
