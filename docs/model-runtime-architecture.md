# Model Runtime Architecture

## 1. Purpose
Define unified runtime abstractions so PaddleOCR, docTR, and YOLO follow one platform contract instead of fragmented framework-specific logic.

## 2. Unified Task Abstraction
`task_type` enum:
- `ocr`
- `detection`
- `classification`
- `segmentation`
- `obb` (optional)

`framework` enum:
- `paddleocr`
- `doctr`
- `yolo`

## 3. Framework Responsibilities
- `paddleocr`: primary OCR training/inference baseline
- `doctr`: OCR fallback/alternative implementation
- `yolo`: primary detection baseline and expansion point for classification/segmentation/OBB

## 4. Unified Trainer Interface
All framework adapters must implement:

```ts
interface UnifiedTrainer {
  framework: 'paddleocr' | 'doctr' | 'yolo';
  supportedTasks: Array<'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb'>;

  validate_dataset(input: ValidateDatasetInput): Promise<ValidateDatasetResult>;
  train(input: TrainInput): Promise<TrainResult>;
  evaluate(input: EvaluateInput): Promise<EvaluateResult>;
  predict(input: PredictInput): Promise<UnifiedInferenceOutput>;
  export(input: ExportInput): Promise<ExportResult>;
  load_model(input: LoadModelInput): Promise<LoadedModelRef>;
}
```

## 5. Unified Inference Output Contract

```ts
interface UnifiedInferenceOutput {
  image: {
    filename: string;
    width: number;
    height: number;
    source_attachment_id?: string;
  };
  task_type: 'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb';
  framework: 'paddleocr' | 'doctr' | 'yolo';
  model: {
    model_id: string;
    model_version_id: string;
    name: string;
    version: string;
  };
  boxes: Array<{ x: number; y: number; width: number; height: number; label: string; score: number }>;
  rotated_boxes: Array<{ cx: number; cy: number; width: number; height: number; angle: number; label: string; score: number }>;
  polygons: Array<{ label: string; score: number; points: Array<{ x: number; y: number }> }>;
  masks: Array<{ label: string; score: number; encoding: string }>;
  labels: Array<{ label: string; score: number }>;
  ocr: {
    lines: Array<{ text: string; confidence: number }>;
    words: Array<{ text: string; confidence: number }>;
  };
  raw_output: unknown;
  normalized_output: Record<string, unknown>;
}
```

## 6. Runtime Pipeline
1. user selects model version + task input
2. adapter registry resolves framework adapter
3. adapter executes framework-specific predict/evaluate
4. adapter maps output into unified inference output
5. platform stores run record and supports feedback-to-dataset action

### 6.1 Runtime Bridge (current progress)
- Predict runtime bridge is now available for all frameworks:
  - PaddleOCR: `PADDLEOCR_RUNTIME_ENDPOINT`, `PADDLEOCR_RUNTIME_API_KEY`
  - docTR: `DOCTR_RUNTIME_ENDPOINT`, `DOCTR_RUNTIME_API_KEY`
  - YOLO: `YOLO_RUNTIME_ENDPOINT`, `YOLO_RUNTIME_API_KEY`
- Request payload includes `framework`, `model_id`, `model_version_id`, `input_attachment_id`, `filename`, `task_type`.
- Response is normalized into the unified inference contract (`boxes` / `rotated_boxes` / `polygons` / `masks` / `labels` / `ocr`).
- If runtime call fails or endpoint is unset, adapter falls back to mock output to keep prototype loop unblocked (`normalized_output.source = mock_fallback`).
- This bridge is still predict-path only; train/evaluate/export/load remain mock in current phase.
- Runtime diagnostics endpoint: `GET /api/runtime/connectivity` for in-app connectivity checks.
  - Includes structured `error_kind` (`none|timeout|network|http_status|invalid_payload|unknown`) for faster troubleshooting.

## 7. Execution Layers
- control layer: API + state machine + permissions
- adapter layer: framework-specific trainers/inferencers
- storage layer: datasets/jobs/metrics/model versions/inference runs
- feedback layer: failed samples return to dataset for next iteration

## 8. Phase Scope
- Phase 1: define interfaces and mock adapters
- Phase 2.5: optional runtime bridge (predict path) with mock fallback
- Phase 3: connect real framework runtimes
- Phase 4: run OCR and detection loops on unified contracts

## 9. Verification Baseline
- `npm run smoke:phase2`
  - verifies fallback behavior when runtime endpoints are unavailable.
- `npm run smoke:runtime-success`
  - boots a local runtime mock server and verifies runtime success path for PaddleOCR/docTR/YOLO (`*_runtime` source).
