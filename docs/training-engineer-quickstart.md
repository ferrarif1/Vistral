# Model Training Engineer Quickstart

This is the shortest working path for a training engineer. Follow it in order.

## 1. Start The Product
1. Copy environment defaults: `cp .env.example .env`
2. Start Docker mode: `npm run docker:up`
3. Open `http://127.0.0.1:8080`
4. Sign in with `alice / mock-pass` for user workflows, or `admin / mock-pass-admin` for admin/runtime checks.
5. Run the health check before any long workflow: `npm run docker:healthcheck`

## 2. Choose The Right Lane
- Use the conversation-assisted lane when the requirement is still fuzzy, you only have example images, or you want the system to draft the task understanding and next steps for you.
- Use the direct console lane when dataset, dataset version, task type, and framework are already known and you just want deterministic execution.

## 3. Fastest Assisted Lane: Chat -> Vision Task -> Train
1. Open `/workspace/chat`.
2. Upload 1-10 sample images and describe the target clearly.
3. Ask for the training goal in plain language.
4. Open the returned `Vision Task` link from the action card.
5. If the task shows `missing_requirements`, use the provided links to fix dataset/version/runtime gaps first.
6. Use `Auto advance` for the fastest safe next step, or use the explicit buttons:
   - `Launch training`
   - `Start round 1` / `Run next round`
   - `Register model`
   - `Mine badcases`
7. Use `/vision/tasks` as the reopenable queue for all assisted workflows; use the linked dataset/training/model pages when you need deeper manual control.

## 4. Prepare Data (Direct Console Lane Or Missing-Requirements Fixes)
1. Open `Datasets`.
2. Create a dataset with the correct task type: `ocr` or `detection`.
3. Upload image files from the dataset detail page.
4. Wait until all files show `ready`; delete failed files before continuing.
5. Create a train/val/test split.
6. Create a dataset version snapshot. Training must use this explicit version, not the live dataset.

Minimum launch gates:
- dataset status is `ready`
- selected dataset version has `split_summary.train > 0`
- selected dataset version has `annotation_coverage > 0`

## 5. Annotate Or Import Labels
1. For manual labels, open the dataset annotation workspace.
2. Save work in progress, then submit ready items for review.
3. For OCR/imported labels, upload an annotation file and use the dataset import action.
4. Fix rejected items before creating the final training snapshot.

## 6. Launch Training
1. Open `Training Jobs -> New`.
2. Choose task/framework:
   - OCR: `paddleocr` or `doctr`
   - detection: `yolo`
3. Select the dataset and explicit dataset version.
4. Keep advanced parameters folded unless you need to override defaults.
5. Submit the job and open the job detail page.

## 7. Register And Validate
1. Wait for the training job to reach `completed`.
2. Open `Model Versions` from the job detail handoff.
3. Register a model version from the completed job.
4. Open `Inference Validate`, select the model version, upload a test image, and run inference.
5. Send bad predictions back to a matching-task feedback dataset.

## 8. Fast Failure Self-Rescue
- Training launch blocked: return to dataset detail, check split train count and annotation coverage, then create a new dataset version.
- Vision task stuck in `requires_input`: open the linked task detail and clear the listed missing requirements instead of restarting the chat from scratch.
- Job failed on worker/offline/timeout: open the job detail failure context and run the top suggestion, or retry with `control_plane`.
- Missing Python/module/local command: open `Settings -> Runtime`, apply local quick setup, then run readiness checks.
- Registration blocked: inspect training job evidence. Simulated, template, or fallback evidence cannot register unless an explicit compatibility override is enabled for smoke-only scenarios.
- OCR fallback output is empty: this is expected safety behavior when local/runtime OCR fails. Fix runtime settings instead of trusting placeholder text.
- Docker verify timeout near the last step: run the failing smoke directly, then rerun the full verify with a longer timeout window.

## 9. Release Checks
Run these before handing off a training platform build:

```bash
npm run smoke:vision-task-closure
npm run smoke:plan-llm-complete
npm run docker:verify:strict-real
npm run docker:verify:pure-real
```

Use `smoke:vision-task-closure` first when the risk is specifically around the assisted `chat -> vision task -> train/register/feedback` lane. Record generated reports from `.data/verify-reports/` in the active plan or release notes.
