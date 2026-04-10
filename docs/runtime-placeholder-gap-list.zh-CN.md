# Runtime 占位能力缺口清单

最后更新：2026-04-10

本清单用于跟踪“看起来像真实结果，但实际仍是模板/模拟/回退”的能力缺口，重点对应此前 OCR 假发票文本问题同类风险。

## 范围与判定标准
- 仅纳入与 OCR 事故同类的问题：固定示例输出、可被误判为真实结果的确定性伪输出、伪成功路径。
- 不纳入仅用于文档展示且明确标注为示例的数据。

## 当前缺口盘点

| 优先级 | 区域 | 当前行为 | 风险 | 状态 |
| --- | --- | --- | --- | --- |
| P0 | OCR 本地模板推理（docTR） | template 模式已统一改为显式占位文本（`TEMPLATE_OCR_LINE_1/2`），并始终附带 `meta.fallback_reason` 与 `meta.template_reason`。 | 容易被误认为真实 OCR。 | 已关闭（2026-04-09） |
| P0 | 推理失败回退（非 OCR） | runtime/local command 硬失败后的显式回退已改为结构化空结果，不再注入检测/分割/分类占位预测。 | 容易被误认为真实预测。 | 已关闭（2026-04-09） |
| P0 | 推理页告警判定 | 页面告警已增加 `raw_output.meta.mode=template` 判定，不再只依赖 `source`/fallback reason。 | template 结果可能被当作成功结果。 | 已关闭（2026-04-09） |
| P0 | 本地确定性伪推理路径（`<framework>_local`） | 已移除当本地命令模板缺失时的 seed 伪推理分支；改为显式空回退（`explicit_fallback_local_command_failed`）。 | seed 伪输出可能被误判为真实推理。 | 已关闭（2026-04-09） |
| P1 | 本地命令分词对空参数处理 | 已修复分词器丢失 `--model-path ''` 这类空参数的问题，避免 runner 参数解析失败后误触发回退。 | 即使有 bundled runner 也可能被误判为命令失败，造成过度回退。 | 已关闭（2026-04-09） |
| P1 | 推理回退回归覆盖 | `smoke:adapter-no-placeholder` 已新增 OCR + detection 失败路径校验：必须返回 `explicit_fallback_local_command_failed`，并保持结构化结果为空且携带明确回退原因。 | 后续重构可能再次引入伪预测输出。 | 已关闭（2026-04-09） |
| P1 | 训练执行真实性提示面 | 训练列表/详情已新增 `real` 与 `template/simulated/unknown` 的显式区分，对终态但缺少真实训练证据的任务展示告警块。 | 运营可能在不知情情况下发布模板/模拟训练产物。 | 已关闭（2026-04-09） |
| P0 | 模型版本注册真实性门禁 | `POST /model-versions/register` 已默认拒绝带非真实本地执行证据的 `local_command` 任务（`mode=template`、存在 `fallback_reason`、或 `training_performed=false`）；仅在显式设置 `MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND=1` 时放开。 | 模板/回退训练输出可能被误发布为可生产模型版本。 | 已关闭（2026-04-10） |
| P0 | YOLO 本地 template 推理输出真实性 | YOLO template runner 已改为显式“空结构结果”（`boxes/rotated_boxes/polygons/masks/labels=[]`）并附带 `meta.template_payload=empty_structured_output`，不再生成确定性伪检测/伪分类内容。 | template 输出可能被误判为真实视觉识别结果。 | 已关闭（2026-04-10） |
| P1 | 本地命令 template 回退原因字段统一 | 对本地命令 template 结果，后端会将 `raw_output.meta.fallback_reason` 同步到 `raw_output.local_command_fallback_reason`，便于前端/脚本统一读取。 | 回退原因分散在多个字段时，自动化校验容易漏检。 | 已关闭（2026-04-10） |
| P1 | 本地训练 template 产物原因字段统一 | bundled 本地训练 runner（`yolo/paddleocr/doctr`）在无法真实执行时，统一输出显式 template 证据：`mode=template`、`fallback_reason=template_mode_default|<reason>`、`template_reason`、`training_performed=false`。 | 缺少显式原因的 template 训练产物容易被误解为真实训练成功。 | 已关闭（2026-04-10） |
| P1 | Adapter `evaluate()` | 已改为优先读取文件产物（`metrics.json` / artifact metrics），无可评估产物时返回空指标。 | 伪指标会被当作真实评估。 | 已关闭（2026-04-09） |
| P1 | Adapter `export()` | 已改为写入真实本地导出产物/manifest（`MODEL_EXPORT_ROOT`，默认 `.data/model-exports`）。 | 导出完成感知与真实状态不一致。 | 已关闭（2026-04-09） |
| P1 | Adapter `load_model()` | 已改为先校验模型产物存在再返回 handle，缺失则显式报错。 | 会误导“模型已成功加载”。 | 已关闭（2026-04-09） |
| P2 | 种子示例数据 | 已新增 `APP_STATE_BOOTSTRAP_MODE=minimal`（首次启动仅保留账号+基座模型）和 `npm run data:reset:foundation`（重写已有 app-state 到最小基线）。 | 用户可能把种子数据当作真实运行记录。 | 已关闭（2026-04-09） |

## 收口原则
- 所有 fallback/template 结果必须在 payload 与页面上双重显式标识。
- 硬失败回退优先返回结构化空结果，避免业务化假内容。
- `evaluate/export/load_model` 必须使用真实文件产物或显式失败/空语义，禁止伪成功。

## 建议验证命令
- `npm run smoke:ocr-fallback-guard`
- `npm run smoke:core-closure`
- `npm run typecheck`
- `npm run lint`
- `npm run build`
