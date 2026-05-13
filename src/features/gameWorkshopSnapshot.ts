import type {
  AnnotationWithReview,
  DatasetItemRecord,
  DatasetRecord,
  InferenceRunRecord,
  ModelRecord,
  ModelVersionRecord,
  RuntimeReadinessReport,
  TaskType,
  TrainingJobRecord,
  TrainingRecipeRecord,
  TrainingWorkerNodeView,
  VisionModelingTaskRecord
} from '../../shared/domain';
import { summarizeAnnotationQueues } from './annotationQueue';
import { api } from '../services/api';

export type GameWorkshopRoomId =
  | 'reception'
  | 'datasets'
  | 'annotation'
  | 'recipes'
  | 'training'
  | 'exam'
  | 'publish'
  | 'runtime'
  | 'bugs';

export interface GameWorkshopRoomSnapshot {
  id: GameWorkshopRoomId;
  number: number;
  title: string;
  subtitle: string;
  summary: string;
  href: string;
  primaryActionLabel: string;
  accent: 'amber' | 'blue' | 'mint' | 'violet' | 'rose' | 'steel';
  scene: {
    persona: 'assistant' | 'warehouse' | 'annotator' | 'recipe' | 'trainer' | 'examiner' | 'graduate' | 'operator' | 'repair';
    device: 'console' | 'shelves' | 'labeler' | 'beakers' | 'gpu' | 'scope' | 'wall' | 'servers' | 'toolbox';
    meterLabel: string;
    meterPercent: number;
  };
  badges: Array<{ label: string; value: string; tone?: 'success' | 'warning' | 'danger' | 'neutral' | 'info' }>;
  details: string[];
}

export interface GameWorkshopTimelineEvent {
  id: string;
  roomId: GameWorkshopRoomId;
  title: string;
  detail: string;
  at: string;
  href: string;
  tone: 'training' | 'dataset' | 'inference' | 'publish' | 'runtime' | 'task';
}

export interface GameWorkshopResourceMetric {
  id: string;
  label: string;
  valueLabel: string;
  percent: number;
  tone: 'success' | 'warning' | 'danger' | 'info';
}

export interface GameWorkshopRoleStatus {
  id: string;
  name: string;
  subtitle: string;
  statusLabel: string;
  href: string;
  roomId: GameWorkshopRoomId;
  persona: 'engineer' | 'exam' | 'recipe' | 'publish' | 'repair';
}

export interface GameWorkshopAssistantMessage {
  id: string;
  sender: 'assistant' | 'user' | 'system';
  text: string;
  href?: string;
  actionLabel?: string;
}

export interface GameWorkshopAssistantSuggestion {
  id: string;
  label: string;
  href: string;
}

export interface GameWorkshopSnapshot {
  generatedAt: string;
  rooms: GameWorkshopRoomSnapshot[];
  timeline: GameWorkshopTimelineEvent[];
  resources: GameWorkshopResourceMetric[];
  dailyNotes: string[];
  modelRoles: GameWorkshopRoleStatus[];
  assistantMessages: GameWorkshopAssistantMessage[];
  assistantSuggestionsByRoom: Record<GameWorkshopRoomId, GameWorkshopAssistantSuggestion[]>;
  datasets: DatasetRecord[];
  modelVersions: ModelVersionRecord[];
  runtimeReadiness: RuntimeReadinessReport | null;
  runtimeReadinessError: string;
  workers: TrainingWorkerNodeView[];
  workerAccessError: string;
}

const activeTrainingStatuses = new Set(['queued', 'preparing', 'running', 'evaluating']);

const parseTime = (value?: string | null): number => {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const clampPercent = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

const formatAgoClock = (value: string): string => {
  const parsed = parseTime(value);
  if (!parsed) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(parsed));
};

const summarizeTaskTypeMix = (datasets: DatasetRecord[]): string => {
  const counts = new Map<TaskType, number>();
  datasets.forEach((dataset) => {
    counts.set(dataset.task_type, (counts.get(dataset.task_type) ?? 0) + 1);
  });
  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([taskType, count]) => `${taskType} ${count}`)
    .join(' · ');
};

const safeListTrainingWorkers = async (): Promise<{
  workers: TrainingWorkerNodeView[];
  error: string;
}> => {
  try {
    return {
      workers: await api.listTrainingWorkers(),
      error: ''
    };
  } catch (error) {
    return {
      workers: [],
      error: (error as Error).message
    };
  }
};

const safeRuntimeReadiness = async (): Promise<{
  report: RuntimeReadinessReport | null;
  error: string;
}> => {
  try {
    return {
      report: await api.getRuntimeReadiness(),
      error: ''
    };
  } catch (error) {
    return {
      report: null,
      error: (error as Error).message
    };
  }
};

const summarizeAnnotations = (
  datasetDiagnostics: Array<{
    items: DatasetItemRecord[];
    annotations: AnnotationWithReview[];
  }>
) => {
  return datasetDiagnostics.reduce(
    (acc, entry) => {
      const summary = summarizeAnnotationQueues(entry.items, entry.annotations);
      acc.total += summary.total;
      acc.needsWork += summary.needs_work;
      acc.inReview += summary.in_review;
      acc.rejected += summary.rejected;
      acc.approved += summary.approved;
      return acc;
    },
    { total: 0, needsWork: 0, inReview: 0, rejected: 0, approved: 0 }
  );
};

const deriveTimeline = (
  datasets: DatasetRecord[],
  trainingJobs: TrainingJobRecord[],
  inferenceRuns: InferenceRunRecord[],
  modelVersions: ModelVersionRecord[],
  visionTasks: VisionModelingTaskRecord[]
): GameWorkshopTimelineEvent[] => {
  const datasetEvents = datasets.map<GameWorkshopTimelineEvent>((dataset) => ({
    id: `dataset-${dataset.id}`,
    roomId: 'datasets',
    title: dataset.name,
    detail: `Dataset ${dataset.status}`,
    at: dataset.updated_at,
    href: `/datasets/${encodeURIComponent(dataset.id)}`,
    tone: 'dataset'
  }));
  const trainingEvents = trainingJobs.map<GameWorkshopTimelineEvent>((job) => ({
    id: `training-${job.id}`,
    roomId: job.status === 'failed' ? 'bugs' : 'training',
    title: job.name,
    detail: `Training ${job.status}`,
    at: job.updated_at,
    href: `/training/jobs/${encodeURIComponent(job.id)}`,
    tone: 'training'
  }));
  const inferenceEvents = inferenceRuns.map<GameWorkshopTimelineEvent>((run) => ({
    id: `inference-${run.id}`,
    roomId: run.status === 'failed' ? 'bugs' : 'exam',
    title: run.normalized_output.model.version || run.id,
    detail: `Inference ${run.status}`,
    at: run.updated_at,
    href: '/inference/validate',
    tone: 'inference'
  }));
  const publishEvents = modelVersions.map<GameWorkshopTimelineEvent>((version) => ({
    id: `version-${version.id}`,
    roomId: 'publish',
    title: version.version_name,
    detail: `Version ${version.status}`,
    at: version.created_at,
    href: '/models/versions',
    tone: 'publish'
  }));
  const taskEvents = visionTasks.map<GameWorkshopTimelineEvent>((task) => ({
    id: `task-${task.id}`,
    roomId: 'reception',
    title: task.id,
    detail: `Task ${task.status}`,
    at: task.updated_at,
    href: `/vision/tasks/${encodeURIComponent(task.id)}`,
    tone: 'task'
  }));

  return [...datasetEvents, ...trainingEvents, ...inferenceEvents, ...publishEvents, ...taskEvents]
    .sort((left, right) => parseTime(right.at) - parseTime(left.at))
    .slice(0, 8)
    .map((event) => ({
      ...event,
      at: formatAgoClock(event.at)
    }));
};

const deriveDailyNotes = (
  trainingJobs: TrainingJobRecord[],
  inferenceRuns: InferenceRunRecord[],
  modelVersions: ModelVersionRecord[],
  datasets: DatasetRecord[]
): string[] => {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const completedTraining = trainingJobs.filter(
    (job) => parseTime(job.updated_at) >= since && job.status === 'completed'
  ).length;
  const failedTraining = trainingJobs.filter(
    (job) => parseTime(job.updated_at) >= since && job.status === 'failed'
  ).length;
  const completedInference = inferenceRuns.filter(
    (run) => parseTime(run.updated_at) >= since && run.status === 'completed'
  ).length;
  const publishedVersions = modelVersions.filter((version) => parseTime(version.created_at) >= since).length;
  const touchedDatasets = datasets.filter((dataset) => parseTime(dataset.updated_at) >= since).length;

  const notes: string[] = [];
  if (completedTraining > 0) {
    notes.push(`完成训练任务 ${completedTraining} 个`);
  }
  if (completedInference > 0) {
    notes.push(`完成推理验证 ${completedInference} 次`);
  }
  if (publishedVersions > 0) {
    notes.push(`新增模型版本 ${publishedVersions} 个`);
  }
  if (touchedDatasets > 0) {
    notes.push(`更新数据集 ${touchedDatasets} 个`);
  }
  if (failedTraining > 0) {
    notes.push(`失败训练 ${failedTraining} 个，需要继续返工`);
  }
  if (notes.length === 0) {
    notes.push('近 24 小时暂无新的闭环动作记录');
  }
  return notes;
};

const deriveResources = (
  runtimeReadiness: RuntimeReadinessReport | null,
  workers: TrainingWorkerNodeView[]
): GameWorkshopResourceMetric[] => {
  const onlineWorkers = workers.filter((worker) => worker.effective_status === 'online');
  const averageWorkerLoad = onlineWorkers.length
    ? Math.round(
        onlineWorkers.reduce((sum, worker) => sum + Math.max(0, Math.min(100, Math.round(worker.load_score))), 0) /
          onlineWorkers.length
      )
    : 0;
  const runtimeIssueCount = runtimeReadiness?.issues.length ?? 0;
  const runtimeErrorCount = runtimeReadiness?.issues.filter((issue) => issue.level === 'error').length ?? 0;
  const configuredFrameworks = runtimeReadiness?.frameworks.filter((item) => item.endpoint_configured || item.local_train_command_configured).length ?? 0;

  return [
    {
      id: 'worker-load',
      label: 'Worker load',
      valueLabel: `${averageWorkerLoad}%`,
      percent: averageWorkerLoad,
      tone: averageWorkerLoad >= 85 ? 'danger' : averageWorkerLoad >= 60 ? 'warning' : 'success'
    },
    {
      id: 'worker-online',
      label: 'Workers online',
      valueLabel: `${onlineWorkers.length}/${workers.length || 0}`,
      percent: workers.length > 0 ? Math.round((onlineWorkers.length / workers.length) * 100) : 0,
      tone: onlineWorkers.length === 0 ? 'danger' : 'success'
    },
    {
      id: 'runtime-ready',
      label: 'Runtime readiness',
      valueLabel: runtimeReadiness ? runtimeReadiness.status : 'unknown',
      percent:
        runtimeReadiness?.status === 'ready'
          ? 100
          : runtimeReadiness?.status === 'degraded'
            ? 58
            : 24,
      tone:
        runtimeReadiness?.status === 'ready'
          ? 'success'
          : runtimeErrorCount > 0
            ? 'danger'
            : 'warning'
    },
    {
      id: 'frameworks',
      label: 'Configured runtimes',
      valueLabel: `${configuredFrameworks}`,
      percent: Math.min(100, configuredFrameworks * 33),
      tone: runtimeIssueCount > 0 ? 'warning' : 'info'
    }
  ];
};

const deriveRoles = (
  models: ModelRecord[],
  modelVersions: ModelVersionRecord[],
  trainingJobs: TrainingJobRecord[],
  inferenceRuns: InferenceRunRecord[]
): GameWorkshopRoleStatus[] => {
  const activeTraining = trainingJobs
    .filter((job) => activeTrainingStatuses.has(job.status))
    .sort((left, right) => parseTime(right.updated_at) - parseTime(left.updated_at));
  const latestRuns = inferenceRuns
    .filter((run) => run.status === 'running' || run.status === 'completed')
    .sort((left, right) => parseTime(right.updated_at) - parseTime(left.updated_at));
  const latestVersions = modelVersions
    .slice()
    .sort((left, right) => parseTime(right.created_at) - parseTime(left.created_at));

  const trainingRoles = activeTraining.slice(0, 2).map<GameWorkshopRoleStatus>((job) => ({
    id: `role-training-${job.id}`,
    name: job.name,
    subtitle: `${job.framework} · ${job.task_type}`,
    statusLabel: job.status === 'running' ? '训练中' : '准备中',
    href: `/training/jobs/${encodeURIComponent(job.id)}/cockpit`,
    roomId: 'training',
    persona: 'engineer'
  }));

  const inferenceRoles = latestRuns.slice(0, 1).map<GameWorkshopRoleStatus>((run) => ({
    id: `role-exam-${run.id}`,
    name: run.normalized_output.model.version || run.id,
    subtitle: `${run.framework} · ${run.task_type}`,
    statusLabel: run.status === 'running' ? '考试中' : '最近考试',
    href: '/inference/validate',
    roomId: 'exam',
    persona: 'exam'
  }));

  const publishRoles = latestVersions.slice(0, 2).map<GameWorkshopRoleStatus>((version) => {
    const model = models.find((item) => item.id === version.model_id);
    return {
      id: `role-version-${version.id}`,
      name: model?.name ?? version.version_name,
      subtitle: version.version_name,
      statusLabel: version.status === 'registered' ? '已毕业' : '待登记',
      href: '/models/versions',
      roomId: 'publish',
      persona: version.status === 'registered' ? 'publish' : 'recipe'
    };
  });

  const repairRoles = trainingJobs
    .filter((job) => job.status === 'failed')
    .slice(0, 1)
    .map<GameWorkshopRoleStatus>((job) => ({
      id: `role-repair-${job.id}`,
      name: job.name,
      subtitle: `${job.framework} · ${job.task_type}`,
      statusLabel: '失败待处理',
      href: `/training/jobs/${encodeURIComponent(job.id)}`,
      roomId: 'bugs',
      persona: 'repair'
    }));

  return [...trainingRoles, ...inferenceRoles, ...publishRoles, ...repairRoles].slice(0, 6);
};

export async function loadGameWorkshopSnapshot(): Promise<GameWorkshopSnapshot> {
  const [
    datasets,
    models,
    modelVersions,
    trainingJobs,
    inferenceRuns,
    visionTasks,
    trainingRecipes,
    runtimeReadinessResult,
    workersResult
  ] = await Promise.all([
    api.listDatasets(),
    api.listModels(),
    api.listModelVersions(),
    api.listTrainingJobs(),
    api.listInferenceRuns(),
    api.listVisionTasks(),
    api.listTrainingRecipes().catch(() => [] as TrainingRecipeRecord[]),
    safeRuntimeReadiness(),
    safeListTrainingWorkers()
  ]);

  const datasetDiagnostics = await Promise.all(
    datasets.map(async (dataset) => {
      try {
        const [items, annotations] = await Promise.all([
          api.listDatasetItems(dataset.id),
          api.listDatasetAnnotations(dataset.id)
        ]);
        return { items, annotations };
      } catch {
        return { items: [] as DatasetItemRecord[], annotations: [] as AnnotationWithReview[] };
      }
    })
  );

  const annotationStats = summarizeAnnotations(datasetDiagnostics);
  const readyDatasetCount = datasets.filter((dataset) => dataset.status === 'ready').length;
  const activeTrainingJobs = trainingJobs.filter((job) => activeTrainingStatuses.has(job.status));
  const failedTrainingJobs = trainingJobs.filter((job) => job.status === 'failed');
  const failedInferenceRuns = inferenceRuns.filter((run) => run.status === 'failed');
  const publishedVersions = modelVersions.filter((version) => version.status === 'registered');
  const pendingVersions = modelVersions.filter((version) => version.status !== 'registered');
  const onlineWorkers = workersResult.workers.filter((worker) => worker.effective_status === 'online');
  const activeLearningSamples = visionTasks.reduce((sum, task) => {
    return sum + (task.active_learning_pool?.total_candidates ?? 0);
  }, 0);
  const latestTask = visionTasks.slice().sort((left, right) => parseTime(right.updated_at) - parseTime(left.updated_at))[0] ?? null;
  const primaryDataset = datasets.find((dataset) => dataset.status === 'ready') ?? datasets[0] ?? null;
  const primaryDatasetPath = primaryDataset ? `/datasets/${encodeURIComponent(primaryDataset.id)}` : '/datasets';
  const primaryAnnotationPath = primaryDataset ? `${primaryDatasetPath}/annotate` : '/datasets';
  const activeTrainingPath = activeTrainingJobs[0]
    ? `/training/jobs/${encodeURIComponent(activeTrainingJobs[0].id)}/cockpit`
    : '/training/jobs';
  const failedWorkPath = failedTrainingJobs[0]
    ? `/training/jobs/${encodeURIComponent(failedTrainingJobs[0].id)}`
    : failedInferenceRuns[0]
      ? '/inference/validate'
      : '/training/jobs';

  const rooms: GameWorkshopRoomSnapshot[] = [
    {
      id: 'reception',
      number: 0,
      title: '接待大厅 / 对话指挥室',
      subtitle: '需求对话、任务创建、助手协同',
      summary: latestTask
        ? `当前任务 ${latestTask.id} 处于 ${latestTask.status}`
        : '当前还没有活跃的对话编排任务',
      href: '/workspace/chat',
      primaryActionLabel: '进入对话',
      accent: 'amber',
      scene: {
        persona: 'assistant',
        device: 'console',
        meterLabel: latestTask ? latestTask.status : 'idle',
        meterPercent: latestTask ? 68 : 18
      },
      badges: [
        { label: '任务', value: String(visionTasks.length), tone: 'info' },
        { label: '待确认', value: String(visionTasks.filter((task) => task.status === 'requires_input').length), tone: 'warning' }
      ],
      details: [
        latestTask?.agent_next_action?.summary || '发起新建模型、上传样本和编排请求。',
        latestTask?.promotion_gate?.summary || '需要确认的动作会回到对话指挥室处理。',
        latestTask?.run_comparison?.summary || '最近任务会在这里进入后续房间。'
      ]
    },
    {
      id: 'datasets',
      number: 1,
      title: '数据集仓库',
      subtitle: '数据集、版本、状态',
      summary: `${datasets.length} 个数据集，${readyDatasetCount} 个 ready`,
      href: primaryDatasetPath,
      primaryActionLabel: '管理数据',
      accent: 'blue',
      scene: {
        persona: 'warehouse',
        device: 'shelves',
        meterLabel: 'ready',
        meterPercent: datasets.length > 0 ? clampPercent((readyDatasetCount / datasets.length) * 100) : 0
      },
      badges: [
        { label: 'Ready', value: String(readyDatasetCount), tone: 'success' },
        { label: 'Draft', value: String(datasets.filter((dataset) => dataset.status === 'draft').length), tone: 'warning' },
        { label: 'Archived', value: String(datasets.filter((dataset) => dataset.status === 'archived').length), tone: 'neutral' }
      ],
      details: [
        summarizeTaskTypeMix(datasets) || '暂无任务类型分布',
        '进入数据集详情继续上传、切分和版本化。',
        '没有数据集时进入数据集列表创建或导入。'
      ]
    },
    {
      id: 'annotation',
      number: 2,
      title: '数据清洗与标注室',
      subtitle: '清洗、标注、审核、反馈池',
      summary: `待处理 ${annotationStats.needsWork} / 审核中 ${annotationStats.inReview} / 被拒 ${annotationStats.rejected}`,
      href: primaryAnnotationPath,
      primaryActionLabel: '进入标注',
      accent: 'mint',
      scene: {
        persona: 'annotator',
        device: 'labeler',
        meterLabel: 'approved',
        meterPercent: annotationStats.total > 0 ? clampPercent((annotationStats.approved / annotationStats.total) * 100) : 0
      },
      badges: [
        { label: 'Needs work', value: String(annotationStats.needsWork), tone: 'warning' },
        { label: 'In review', value: String(annotationStats.inReview), tone: 'info' },
        { label: 'Feedback', value: String(activeLearningSamples), tone: activeLearningSamples > 0 ? 'warning' : 'neutral' }
      ],
      details: [
        `已通过 ${annotationStats.approved} 条`,
        '进入标注工作台、复核队列和反馈样本修正链路。',
        '标注覆盖和问题样本会直接影响后续训练就绪。'
      ]
    },
    {
      id: 'recipes',
      number: 3,
      title: '模型配方室',
      subtitle: '任务类型、框架、基座模型、参数',
      summary: `${trainingRecipes.length} 个 recipe，可连接训练启动与 runtime 设置`,
      href: '/training/jobs/new',
      primaryActionLabel: '配置训练',
      accent: 'violet',
      scene: {
        persona: 'recipe',
        device: 'beakers',
        meterLabel: 'recipes',
        meterPercent: clampPercent(Math.min(trainingRecipes.length, 6) * 16)
      },
      badges: [
        { label: 'Recipes', value: String(trainingRecipes.length), tone: 'info' },
        { label: 'Frameworks', value: String(new Set(trainingRecipes.map((recipe) => recipe.framework)).size), tone: 'neutral' },
        { label: 'Runtime', value: runtimeReadinessResult.report?.status ?? 'unknown', tone: runtimeReadinessResult.report?.status === 'ready' ? 'success' : 'warning' }
      ],
      details: [
        trainingRecipes[0]
          ? `${trainingRecipes[0].title} · ${trainingRecipes[0].default_base_model}`
          : '选择任务类型、框架、基座模型和参数。',
        runtimeReadinessResult.error || '运行环境阻塞时进入设置修复。',
        '训练参数在创建训练任务时确认。'
      ]
    },
    {
      id: 'training',
      number: 4,
      title: '训练室',
      subtitle: '排队、准备、运行、评估、worker',
      summary: `${activeTrainingJobs.length} 个活跃训练任务，${onlineWorkers.length} 个 worker 在线`,
      href: activeTrainingPath,
      primaryActionLabel: activeTrainingJobs[0] ? '查看训练' : '训练队列',
      accent: 'steel',
      scene: {
        persona: 'trainer',
        device: 'gpu',
        meterLabel: activeTrainingJobs[0]?.status ?? 'idle',
        meterPercent: activeTrainingJobs.length > 0 ? 72 : 12
      },
      badges: [
        { label: 'Running', value: String(trainingJobs.filter((job) => job.status === 'running').length), tone: 'info' },
        { label: 'Queued', value: String(trainingJobs.filter((job) => job.status === 'queued').length), tone: 'warning' },
        { label: 'Failed', value: String(failedTrainingJobs.length), tone: failedTrainingJobs.length > 0 ? 'danger' : 'neutral' }
      ],
      details: [
        activeTrainingJobs[0]?.log_excerpt || '高亮当前训练中的任务，并显示其运行概况。',
        '点击进入训练详情或 cockpit。',
        workersResult.error || 'worker 节点状态会在这里汇总展示。'
      ]
    },
    {
      id: 'exam',
      number: 5,
      title: '推理验证室 / 考试室',
      subtitle: '模型考试、推理验证、badcase',
      summary: `${inferenceRuns.length} 次推理运行，${failedInferenceRuns.length} 次失败或需返工`,
      href: '/inference/validate',
      primaryActionLabel: '开始考试',
      accent: 'blue',
      scene: {
        persona: 'examiner',
        device: 'scope',
        meterLabel: 'passed',
        meterPercent:
          inferenceRuns.length > 0
            ? clampPercent((inferenceRuns.filter((run) => run.status === 'completed').length / inferenceRuns.length) * 100)
            : 0
      },
      badges: [
        { label: 'Running', value: String(inferenceRuns.filter((run) => run.status === 'running').length), tone: 'info' },
        { label: 'Completed', value: String(inferenceRuns.filter((run) => run.status === 'completed').length), tone: 'success' },
        { label: 'Failed', value: String(failedInferenceRuns.length), tone: failedInferenceRuns.length > 0 ? 'danger' : 'neutral' }
      ],
      details: [
        inferenceRuns[0]?.feedback_dataset_id
          ? `最近一次反馈数据集 ${inferenceRuns[0].feedback_dataset_id}`
          : '可在这里手动选择模型版本和测试数据集发起考试。',
        'badcase 与反馈数据应明确回流到数据和训练链路。',
        '支持进入现有推理验证页面执行真实动作。'
      ]
    },
    {
      id: 'publish',
      number: 6,
      title: '模型发布室 / 毕业室',
      subtitle: '版本注册、审批、荣誉墙',
      summary: `${publishedVersions.length} 个已毕业模型版本，${pendingVersions.length} 个待跟进`,
      href: '/models/versions',
      primaryActionLabel: '查看版本',
      accent: 'amber',
      scene: {
        persona: 'graduate',
        device: 'wall',
        meterLabel: 'registered',
        meterPercent:
          modelVersions.length > 0 ? clampPercent((publishedVersions.length / modelVersions.length) * 100) : 0
      },
      badges: [
        { label: 'Registered', value: String(publishedVersions.length), tone: 'success' },
        { label: 'Pending', value: String(pendingVersions.length), tone: pendingVersions.length > 0 ? 'warning' : 'neutral' }
      ],
      details: [
        publishedVersions[0]?.version_name || '已发布模型会展示在荣誉墙区域。',
        '从这里进入版本注册、审批和导出动作。',
        '已发布版本会保留产物、审批和回滚记录。'
      ]
    },
    {
      id: 'runtime',
      number: 7,
      title: '部署运行与监控室',
      subtitle: 'runtime、worker、服务健康',
      summary: runtimeReadinessResult.report
        ? `Runtime ${runtimeReadinessResult.report.status}`
        : runtimeReadinessResult.error || 'runtime 就绪状态暂不可用',
      href: '/settings/runtime',
      primaryActionLabel: '检查运行',
      accent: 'steel',
      scene: {
        persona: 'operator',
        device: 'servers',
        meterLabel: runtimeReadinessResult.report?.status ?? 'unknown',
        meterPercent:
          runtimeReadinessResult.report?.status === 'ready'
            ? 100
            : runtimeReadinessResult.report?.status === 'degraded'
              ? 58
              : 24
      },
      badges: [
        { label: 'Runtime', value: runtimeReadinessResult.report?.status ?? 'unknown', tone: runtimeReadinessResult.report?.status === 'ready' ? 'success' : 'warning' },
        { label: 'Workers', value: `${onlineWorkers.length}/${workersResult.workers.length || 0}`, tone: onlineWorkers.length > 0 ? 'success' : 'warning' },
        { label: 'Issues', value: String(runtimeReadinessResult.report?.issues.length ?? 0), tone: (runtimeReadinessResult.report?.issues.length ?? 0) > 0 ? 'warning' : 'neutral' }
      ],
      details: [
        runtimeReadinessResult.report?.issues[0]?.message || runtimeReadinessResult.error || '汇总部署运行、API 和推理服务状态。',
        workersResult.error || '点击可进入 runtime 设置或 worker 详情页。',
        '超阈值时应使用橙色或红色警告。'
      ]
    },
    {
      id: 'bugs',
      number: 0,
      title: 'Bug 修复与反馈回流区',
      subtitle: '失败训练、失败推理、反馈回流',
      summary: `${failedTrainingJobs.length} 个失败训练，${failedInferenceRuns.length} 个失败推理`,
      href: failedWorkPath,
      primaryActionLabel: '处理问题',
      accent: 'rose',
      scene: {
        persona: 'repair',
        device: 'toolbox',
        meterLabel: 'issues',
        meterPercent: clampPercent((failedTrainingJobs.length + failedInferenceRuns.length + activeLearningSamples) * 10)
      },
      badges: [
        { label: 'Train failures', value: String(failedTrainingJobs.length), tone: failedTrainingJobs.length > 0 ? 'danger' : 'neutral' },
        { label: 'Inference failures', value: String(failedInferenceRuns.length), tone: failedInferenceRuns.length > 0 ? 'danger' : 'neutral' },
        { label: 'Feedback pool', value: String(activeLearningSamples), tone: activeLearningSamples > 0 ? 'warning' : 'neutral' }
      ],
      details: [
        failedTrainingJobs[0]?.log_excerpt || failedInferenceRuns[0]?.execution_source || '展示失败原因、返工建议和回流入口。',
        '应与标注室和训练室形成回环。',
        '优先提供查看日志、修复数据、再训练等明确动作。'
      ]
    }
  ];

  const assistantMessages: GameWorkshopAssistantMessage[] = [
    {
      id: 'assistant-1',
      sender: 'assistant',
      text:
        latestTask?.agent_next_action?.summary ||
        '可以告诉我你想训练什么模型，或者让我带你查看当前房间的下一步动作。'
    },
    {
      id: 'user-1',
      sender: 'user',
      text:
        activeTrainingJobs[0]?.name
          ? `帮我继续跟进 ${activeTrainingJobs[0].name}`
          : '帮我看看当前最优先该做什么'
    },
    {
      id: 'assistant-2',
      sender: 'assistant',
      text:
        activeTrainingJobs[0]?.status === 'running'
          ? '训练室里有运行中的任务，我已经把训练室高亮，并给出 cockpit 入口。'
          : '当前最明显的下一步通常是先补齐数据、标注或配方条件。'
    }
  ];

  const assistantSuggestionsByRoom: Record<GameWorkshopRoomId, GameWorkshopAssistantSuggestion[]> = {
    reception: [
      { id: 'suggest-chat', label: '打开对话指挥室', href: '/workspace/chat' },
      { id: 'suggest-task', label: '打开 Vision Tasks', href: '/vision/tasks' }
    ],
    datasets: [
      { id: 'suggest-datasets', label: '管理数据集', href: '/datasets' },
      { id: 'suggest-import', label: '进入数据集仓库', href: '/datasets' }
    ],
    annotation: [
      { id: 'suggest-annotate', label: '进入标注工作台', href: '/datasets' },
      { id: 'suggest-review', label: '查看待审核样本', href: '/datasets' }
    ],
    recipes: [
      { id: 'suggest-launch', label: '打开训练启动', href: '/training/jobs/new' },
      { id: 'suggest-runtime', label: '检查 Runtime', href: '/settings/runtime' }
    ],
    training: [
      { id: 'suggest-jobs', label: '查看训练任务', href: '/training/jobs' },
      { id: 'suggest-cockpit', label: '打开训练驾驶舱', href: '/training/jobs' }
    ],
    exam: [
      { id: 'suggest-exam', label: '开始考试', href: '/inference/validate' },
      { id: 'suggest-feedback', label: '查看反馈数据', href: '/datasets' }
    ],
    publish: [
      { id: 'suggest-versions', label: '打开模型版本', href: '/models/versions' },
      { id: 'suggest-approvals', label: '查看审批', href: '/admin/models/pending' }
    ],
    runtime: [
      { id: 'suggest-runtime-settings', label: '打开 Runtime 设置', href: '/settings/runtime' },
      { id: 'suggest-workers', label: '查看 Worker 节点', href: '/settings/workers' }
    ],
    bugs: [
      { id: 'suggest-failures', label: '查看失败训练', href: '/training/jobs' },
      { id: 'suggest-fix-data', label: '返回数据修复', href: '/datasets' }
    ]
  };

  return {
    generatedAt: new Date().toISOString(),
    rooms,
    timeline: deriveTimeline(datasets, trainingJobs, inferenceRuns, modelVersions, visionTasks),
    resources: deriveResources(runtimeReadinessResult.report, workersResult.workers),
    dailyNotes: deriveDailyNotes(trainingJobs, inferenceRuns, modelVersions, datasets),
    modelRoles: deriveRoles(models, modelVersions, trainingJobs, inferenceRuns),
    assistantMessages,
    assistantSuggestionsByRoom,
    datasets,
    modelVersions,
    runtimeReadiness: runtimeReadinessResult.report,
    runtimeReadinessError: runtimeReadinessResult.error,
    workers: workersResult.workers,
    workerAccessError: workersResult.error
  };
}
