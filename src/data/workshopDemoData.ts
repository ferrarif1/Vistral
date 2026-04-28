export type WorkshopStageId =
  | 'idle'
  | 'dataset_selecting'
  | 'dataset_preparing'
  | 'labeling_or_reviewing'
  | 'training'
  | 'tuning'
  | 'inference_validating'
  | 'human_review_required'
  | 'publishing'
  | 'completed'
  | 'failed';

export type WorkshopRoomId = 'center' | 'dataset' | 'training' | 'exam';
export type WorkshopCharacterId = 'robot' | 'scientist' | 'wizard';
export type WorkshopCharacterAction =
  | 'idle'
  | 'walk'
  | 'organize'
  | 'review'
  | 'train'
  | 'tune'
  | 'exam'
  | 'waiting'
  | 'publish'
  | 'celebrate'
  | 'failed';

export interface WorkshopStageConfig {
  label: string;
  room: WorkshopRoomId;
  bubble: string;
  action: WorkshopCharacterAction;
  timelineIndex: number;
  nextSuggestion: string;
}

export interface WorkshopCharacter {
  id: WorkshopCharacterId;
  name: string;
  type: string;
  asset: string;
  description: string;
}

export interface WorkshopDataset {
  id: string;
  name: string;
  taskType: string;
  samples: number;
  version: string;
  recommendedFor: WorkshopCharacterId[];
}

export interface WorkshopMetricSet {
  accuracy: number;
  recall: number;
  map: number;
  ocrRate: number;
  ruleCheck: 'pass' | 'review';
}

export interface WorkshopTask {
  name: string;
  stage: WorkshopStageId;
  characterId: WorkshopCharacterId;
  datasetId: string;
  validationDatasetId: string;
  round: number;
  progress: number;
  metrics: WorkshopMetricSet;
  latestEvent: string;
}

export const workshopStages: Record<WorkshopStageId, WorkshopStageConfig> = {
  idle: {
    label: '待命',
    room: 'center',
    bubble: '待命中',
    action: 'idle',
    timelineIndex: 0,
    nextSuggestion: '选择一个模型角色和训练数据集。'
  },
  dataset_selecting: {
    label: '选择数据集',
    room: 'dataset',
    bubble: '正在挑选数据集',
    action: 'walk',
    timelineIndex: 0,
    nextSuggestion: '确认数据集版本，然后进入样本整理。'
  },
  dataset_preparing: {
    label: '数据整理',
    room: 'dataset',
    bubble: '整理样本中',
    action: 'organize',
    timelineIndex: 1,
    nextSuggestion: '检查样本入库、版本标签和数据覆盖。'
  },
  labeling_or_reviewing: {
    label: '标注审核',
    room: 'training',
    bubble: '检查标签',
    action: 'review',
    timelineIndex: 2,
    nextSuggestion: '修正标注或进入训练实验室。'
  },
  training: {
    label: '模型训练',
    room: 'training',
    bubble: '训练中',
    action: 'train',
    timelineIndex: 3,
    nextSuggestion: '观察训练进度、日志和中间指标。'
  },
  tuning: {
    label: '调参优化',
    room: 'training',
    bubble: '调整参数',
    action: 'tune',
    timelineIndex: 3,
    nextSuggestion: '微调参数后进入推理验证。'
  },
  inference_validating: {
    label: '推理验证',
    room: 'exam',
    bubble: '准备考试',
    action: 'exam',
    timelineIndex: 4,
    nextSuggestion: '选择验证数据集，或自动选择推荐数据集。'
  },
  human_review_required: {
    label: '人工确认',
    room: 'exam',
    bubble: '等待确认',
    action: 'waiting',
    timelineIndex: 5,
    nextSuggestion: '请选择通过发布、退回训练或重新选择数据集。'
  },
  publishing: {
    label: '模型发布',
    room: 'exam',
    bubble: '发布版本',
    action: 'publish',
    timelineIndex: 6,
    nextSuggestion: '正在生成版本徽章与发布前记录。'
  },
  completed: {
    label: '完成',
    room: 'center',
    bubble: '任务完成',
    action: 'celebrate',
    timelineIndex: 6,
    nextSuggestion: '训练闭环完成，可以进入模型版本管理。'
  },
  failed: {
    label: '失败',
    room: 'training',
    bubble: '需要返工',
    action: 'failed',
    timelineIndex: 3,
    nextSuggestion: '查看最近事件后重试训练或重新整理数据。'
  }
};

export const workshopTimeline = [
  { id: 'dataset_selecting', label: '数据集选择' },
  { id: 'dataset_preparing', label: '数据整理' },
  { id: 'labeling_or_reviewing', label: '标注审核' },
  { id: 'training', label: '训练调参' },
  { id: 'inference_validating', label: '推理验证' },
  { id: 'human_review_required', label: '人工确认' },
  { id: 'publishing', label: '模型发布' }
] as const;

export const workshopRoomPositions: Record<WorkshopRoomId, { x: number; y: number }> = {
  center: { x: 50, y: 74 },
  dataset: { x: 19, y: 55 },
  training: { x: 50, y: 55 },
  exam: { x: 81, y: 55 }
};

export const modelCharacters: WorkshopCharacter[] = [
  {
    id: 'robot',
    name: '工程机甲模型',
    type: '视觉检测 / OCR / 缺陷识别',
    asset: '/assets/vistral-workshop/robot.png',
    description: '适合铁路图像识别、车号 OCR、目标检测和缺陷检测。'
  },
  {
    id: 'scientist',
    name: '科学家模型',
    type: '通用视觉理解 / 分类 / 指标分析',
    asset: '/assets/vistral-workshop/scientist.png',
    description: '适合样本分析、指标评估、规则校验和结果解释。'
  },
  {
    id: 'wizard',
    name: '魔法师模型',
    type: 'LLM 任务理解 / 编排 / 报告生成',
    asset: '/assets/vistral-workshop/wizard.png',
    description: '适合自然语言任务解析、训练编排和复盘报告生成。'
  }
];

export const demoDatasets: WorkshopDataset[] = [
  {
    id: 'train-number-ocr',
    name: '车号 OCR 数据集',
    taskType: 'OCR',
    samples: 1240,
    version: 'v1.3',
    recommendedFor: ['robot', 'scientist']
  },
  {
    id: 'vehicle-defect',
    name: '车辆缺陷检测数据集',
    taskType: 'Detection',
    samples: 2860,
    version: 'v2.1',
    recommendedFor: ['robot']
  },
  {
    id: 'object-detection',
    name: '目标检测数据集',
    taskType: 'Detection',
    samples: 3200,
    version: 'v1.8',
    recommendedFor: ['robot', 'scientist']
  },
  {
    id: 'inspection-review',
    name: '巡检复核数据集',
    taskType: 'Review',
    samples: 680,
    version: 'v0.9',
    recommendedFor: ['scientist', 'wizard']
  }
];

export const defaultWorkshopMetrics: WorkshopMetricSet = {
  accuracy: 0,
  recall: 0,
  map: 0,
  ocrRate: 0,
  ruleCheck: 'review'
};

export const mockWorkshopTask: WorkshopTask = {
  name: 'Vistral 车号 OCR 训练闭环',
  stage: 'idle',
  characterId: 'robot',
  datasetId: demoDatasets[0].id,
  validationDatasetId: demoDatasets[0].id,
  round: 1,
  progress: 0,
  metrics: defaultWorkshopMetrics,
  latestEvent: '训练工坊已就绪。'
};

export const automaticDemoSequence: WorkshopStageId[] = [
  'idle',
  'dataset_selecting',
  'dataset_preparing',
  'labeling_or_reviewing',
  'training',
  'tuning',
  'inference_validating',
  'human_review_required'
];

export function buildMockValidationMetrics(datasetId: string): WorkshopMetricSet {
  const offset = datasetId.length % 5;
  return {
    accuracy: 92.4 + offset * 0.2,
    recall: 88.7 + offset * 0.3,
    map: 0.86 + offset * 0.01,
    ocrRate: 91.8 + offset * 0.2,
    ruleCheck: 'pass'
  };
}

export function mapVistralTaskToWorkshopStage(task: { status?: string } | null | undefined): WorkshopStageId {
  const status = String(task?.status ?? '').toLowerCase();
  if (['created', 'queued', 'draft', 'plan_ready'].includes(status)) {
    return 'dataset_selecting';
  }
  if (['preparing_dataset', 'preparing', 'dataset_preparing'].includes(status)) {
    return 'dataset_preparing';
  }
  if (['labeling', 'reviewing', 'requires_input'].includes(status)) {
    return 'labeling_or_reviewing';
  }
  if (['running', 'training', 'training_started'].includes(status)) {
    return 'training';
  }
  if (['tuning', 'optimizing'].includes(status)) {
    return 'tuning';
  }
  if (['validating', 'inferencing', 'evaluating', 'training_completed'].includes(status)) {
    return 'inference_validating';
  }
  if (['awaiting_review', 'needs_review'].includes(status)) {
    return 'human_review_required';
  }
  if (['publishing', 'approved', 'registered'].includes(status)) {
    return 'publishing';
  }
  if (['completed', 'published'].includes(status)) {
    return 'completed';
  }
  if (['failed', 'error', 'cancelled'].includes(status)) {
    return 'failed';
  }
  return 'idle';
}
