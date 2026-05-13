import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type {
  ApprovalRequest,
  DatasetRecord,
  InferenceRunRecord,
  ModelVersionRecord,
  RuntimeReadinessReport,
  TrainingJobRecord,
  TrainingWorkerNodeView,
  User,
  VisionModelingTaskRecord,
  VisionTaskAgentAction,
  VisionTaskAgentRecommendation
} from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import ProgressStepper from '../components/ui/ProgressStepper';
import { api } from '../services/api';

type OptionalLoad<T> = {
  data: T;
  error: string;
};

interface StudioSnapshot {
  user: User;
  datasets: DatasetRecord[];
  visionTasks: VisionModelingTaskRecord[];
  trainingJobs: TrainingJobRecord[];
  modelVersions: ModelVersionRecord[];
  inferenceRuns: InferenceRunRecord[];
  approvals: ApprovalRequest[];
  runtime: OptionalLoad<RuntimeReadinessReport | null>;
  workers: OptionalLoad<TrainingWorkerNodeView[]>;
}

interface StudioAction {
  label: string;
  to: string;
  tone: 'primary' | 'secondary' | 'ghost';
}

interface StudioMission {
  step: number;
  objective: string;
  rationale: string;
  primary: StudioAction;
  secondary: StudioAction[];
  tone: 'success' | 'warning' | 'danger' | 'info';
  delivery?: {
    status: 'ready' | 'needs_review' | 'blocked' | 'restricted';
    summary: string;
    blockers: string[];
    commands: string[];
  };
}

const studioSteps = [
  '目标',
  '数据',
  '标注',
  '配方',
  '训练',
  '验证',
  '发布',
  '部署',
  '反馈'
];

const activeTrainingStatuses = new Set(['queued', 'preparing', 'running', 'evaluating']);

const settle = async <T,>(promise: Promise<T>, fallback: T): Promise<OptionalLoad<T>> => {
  try {
    return { data: await promise, error: '' };
  } catch (error) {
    return { data: fallback, error: (error as Error).message };
  }
};

const sortByUpdatedDesc = <T extends { updated_at?: string; created_at: string }>(items: T[]) =>
  [...items].sort((left, right) => {
    const leftTime = Date.parse(left.updated_at ?? left.created_at);
    const rightTime = Date.parse(right.updated_at ?? right.created_at);
    return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
  });

const formatDateTime = (value: string) => {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(parsed));
};

const isReadyDataset = (dataset: DatasetRecord) => dataset.status === 'ready';

const buildChatPath = (currentPath: string, prompt: string) => {
  const params = new URLSearchParams();
  params.set('return_to', currentPath);
  params.set('prompt', prompt);
  return `/workspace/chat?${params.toString()}`;
};

const getRuntimeTone = (status?: RuntimeReadinessReport['status']) => {
  if (status === 'ready') {
    return 'success';
  }
  if (status === 'not_ready') {
    return 'danger';
  }
  return 'warning';
};

const visionTaskAgentStep = (action: VisionTaskAgentAction): number => {
  switch (action) {
    case 'requires_input':
      return 0;
    case 'collect_data':
    case 'fix_runtime':
      return 1;
    case 'start_training':
    case 'wait_training':
      return 4;
    case 'register_model':
      return 6;
    case 'mine_feedback':
    case 'completed':
      return 8;
    default:
      return 0;
  }
};

const buildMissionFromVisionTaskRecommendation = (
  task: VisionModelingTaskRecord,
  rec: VisionTaskAgentRecommendation,
  runtime: RuntimeReadinessReport | null
): StudioMission | null => {
  if (rec.action === 'requires_input') {
    return null;
  }

  const step = visionTaskAgentStep(rec.action);
  const rationaleLine =
    rec.reason.trim().length > 0 ? rec.reason.trim() : `VisionTask ${task.id} 的 Agent 建议。`;
  let primary: StudioAction;
  let secondary: StudioAction[];
  let tone: StudioMission['tone'] = 'info';
  let delivery: StudioMission['delivery'];

  switch (rec.action) {
    case 'start_training': {
      const qs = new URLSearchParams();
      if (task.dataset_id) {
        qs.set('dataset', task.dataset_id);
      }
      if (task.dataset_version_id) {
        qs.set('dataset_version', task.dataset_version_id);
      }
      if (task.spec?.task_type) {
        qs.set('task_type', task.spec.task_type);
      }
      qs.set('vision_task', task.id);
      primary = {
        label: rec.title.trim() || '启动训练',
        to: `/training/jobs/new?${qs.toString()}`,
        tone: 'primary'
      };
      secondary = [
        { label: '任务详情', to: `/vision/tasks/${task.id}`, tone: 'secondary' },
        { label: '任务列表', to: '/vision/tasks', tone: 'ghost' }
      ];
      tone = 'success';
      break;
    }
    case 'wait_training': {
      const jobId = (task.training_job_id ?? '').trim();
      if (!jobId) {
        return null;
      }
      primary = {
        label: rec.title.trim() || '查看训练进度',
        to: `/training/jobs/${jobId}`,
        tone: 'primary'
      };
      secondary = [
        { label: '训练驾驶舱', to: `/training/jobs/${jobId}/cockpit`, tone: 'secondary' },
        { label: '任务详情', to: `/vision/tasks/${task.id}`, tone: 'ghost' }
      ];
      tone = 'info';
      break;
    }
    case 'collect_data': {
      const datasetId = (task.dataset_id ?? '').trim();
      primary = datasetId
        ? { label: rec.title.trim() || '完善数据', to: `/datasets/${datasetId}`, tone: 'primary' }
        : { label: rec.title.trim() || '打开数据集', to: '/datasets', tone: 'primary' };
      secondary = [{ label: '任务详情', to: `/vision/tasks/${task.id}`, tone: 'ghost' }];
      tone = 'warning';
      break;
    }
    case 'fix_runtime': {
      const qs = new URLSearchParams();
      qs.set('focus', 'readiness');
      qs.set('agent_action', 'fix_runtime');
      qs.set('vision_task', task.id);
      qs.set('return_to', `/vision/tasks/${task.id}`);
      if (task.spec?.task_type) {
        qs.set('task_type', task.spec.task_type);
      }
      primary = {
        label: rec.title.trim() || '修复真实训练环境',
        to: `/settings/runtime?${qs.toString()}`,
        tone: 'primary'
      };
      secondary = [
        { label: 'Workers', to: '/settings/workers', tone: 'secondary' },
        { label: '任务详情', to: `/vision/tasks/${task.id}`, tone: 'ghost' }
      ];
      delivery = runtime?.agent_delivery
        ? {
            status: runtime.agent_delivery.status,
            summary: runtime.agent_delivery.summary,
            blockers: runtime.agent_delivery.blockers,
            commands: runtime.agent_delivery.commands
          }
        : {
            status: 'restricted',
            summary:
              'Agent delivery stopped because registerable model output needs real runtime evidence.',
            blockers: rec.blocking_items.length > 0
              ? rec.blocking_items
              : ['real training artifact evidence is required before registration'],
            commands: ['npm run doctor:real-training-readiness']
          };
      tone = 'warning';
      break;
    }
    case 'register_model': {
      primary = {
        label: rec.title.trim() || '注册模型版本',
        to: `/vision/tasks/${task.id}`,
        tone: 'primary'
      };
      secondary = [
        { label: '模型版本', to: '/models/versions', tone: 'secondary' },
        {
          label: '最近训练',
          to: task.training_job_id ? `/training/jobs/${task.training_job_id}` : '/training/jobs',
          tone: 'ghost'
        }
      ];
      tone = 'warning';
      break;
    }
    case 'mine_feedback': {
      primary = {
        label: rec.title.trim() || '挖掘反馈样本',
        to: `/vision/tasks/${task.id}`,
        tone: 'primary'
      };
      secondary = [{ label: '推理验证', to: '/inference/validate', tone: 'ghost' }];
      tone = 'info';
      break;
    }
    case 'completed': {
      primary = {
        label: rec.title.trim() || '查看任务结论',
        to: `/vision/tasks/${task.id}`,
        tone: 'primary'
      };
      secondary = [{ label: '任务收件箱', to: '/vision/tasks', tone: 'ghost' }];
      tone = 'success';
      break;
    }
    default:
      return null;
  }

  return {
    step,
    objective: rec.title.trim() || '跟进 Agent 任务',
    rationale: rationaleLine,
    primary,
    secondary,
    tone,
    delivery
  };
};

const resolveMission = (snapshot: StudioSnapshot): StudioMission => {
  const readyDatasets = snapshot.datasets.filter(isReadyDataset);
  const latestJob = sortByUpdatedDesc(snapshot.trainingJobs)[0] ?? null;
  const activeJob = sortByUpdatedDesc(snapshot.trainingJobs).find((job) =>
    activeTrainingStatuses.has(job.status)
  );
  const failedJob = sortByUpdatedDesc(snapshot.trainingJobs).find((job) => job.status === 'failed');
  const registeredVersion =
    sortByUpdatedDesc(snapshot.modelVersions).find((version) => version.status === 'registered') ??
    null;
  const pendingApproval = snapshot.approvals.find((approval) => approval.status === 'pending');
  const blockedTask = sortByUpdatedDesc(snapshot.visionTasks).find((task) =>
    ['requires_input', 'failed'].includes(task.status)
  );

  if (blockedTask) {
    return {
      step: 0,
      objective: '补齐 Agent 任务输入',
      rationale: `任务 ${blockedTask.id} 需要补充信息，先修复目标再继续训练链路。`,
      primary: { label: '打开任务', to: `/vision/tasks/${blockedTask.id}`, tone: 'primary' },
      secondary: [
        { label: '任务列表', to: '/vision/tasks', tone: 'ghost' },
        { label: '进入对话', to: buildChatPath('/workspace/console', '帮我补齐当前视觉建模任务的缺失信息。'), tone: 'ghost' }
      ],
      tone: 'warning'
    };
  }

  if (snapshot.datasets.length === 0) {
    return {
      step: 1,
      objective: '导入第一批训练数据',
      rationale: '还没有数据集，Agent 无法形成可训练的样本快照。',
      primary: { label: '导入数据集', to: '/datasets', tone: 'primary' },
      secondary: [
        { label: '本地文件夹训练', to: '/workflow/closure', tone: 'secondary' },
        { label: '对话创建任务', to: buildChatPath('/workspace/console', '我要导入一个带标注的本地数据文件夹并启动训练。'), tone: 'ghost' }
      ],
      tone: 'warning'
    };
  }

  if (readyDatasets.length === 0) {
    const dataset = sortByUpdatedDesc(snapshot.datasets)[0];
    return {
      step: 1,
      objective: '修复数据集可训练状态',
      rationale: `${dataset.name} 还没有进入 ready 状态，先处理上传、切分或版本化。`,
      primary: { label: '检查数据集', to: `/datasets/${dataset.id}`, tone: 'primary' },
      secondary: [
        { label: '数据列表', to: '/datasets', tone: 'ghost' },
        { label: '问 OpenClaw', to: buildChatPath('/workspace/console', `检查数据集 ${dataset.name} 为什么不能训练。`), tone: 'ghost' }
      ],
      tone: 'warning'
    };
  }

  if (failedJob) {
    return {
      step: 4,
      objective: '修复失败训练',
      rationale: `${failedJob.name} 训练失败，需要先查看日志、数据快照和运行环境。`,
      primary: { label: '查看失败训练', to: `/training/jobs/${failedJob.id}`, tone: 'primary' },
      secondary: [
        { label: '训练列表', to: '/training/jobs', tone: 'ghost' },
        { label: '运行环境', to: '/settings/runtime', tone: 'ghost' }
      ],
      tone: 'danger'
    };
  }

  if (activeJob) {
    return {
      step: 4,
      objective: '监控正在训练的模型',
      rationale: `${activeJob.name} 处于 ${activeJob.status}，先盯住日志、指标和 worker 调度。`,
      primary: { label: '进入训练驾驶舱', to: `/training/jobs/${activeJob.id}/cockpit`, tone: 'primary' },
      secondary: [
        { label: '训练详情', to: `/training/jobs/${activeJob.id}`, tone: 'secondary' },
        { label: 'Worker 设置', to: '/settings/workers', tone: 'ghost' }
      ],
      tone: 'info'
    };
  }

  for (const task of sortByUpdatedDesc(snapshot.visionTasks)) {
    if (task.missing_requirements.length > 0) {
      continue;
    }
    if (['failed'].includes(task.status)) {
      continue;
    }
    const rec = task.agent_next_action;
    if (!rec || rec.action === 'requires_input') {
      continue;
    }
    const led = buildMissionFromVisionTaskRecommendation(task, rec, snapshot.runtime.data);
    if (led) {
      return led;
    }
  }

  if (!latestJob) {
    const dataset = readyDatasets[0];
    const params = new URLSearchParams({ dataset: dataset.id, task_type: dataset.task_type });
    return {
      step: 3,
      objective: '选择训练配方并启动训练',
      rationale: `${dataset.name} 已可用，下一步是选择框架、配方和执行目标。`,
      primary: { label: '启动训练', to: `/training/jobs/new?${params.toString()}`, tone: 'primary' },
      secondary: [
        { label: '查看数据集', to: `/datasets/${dataset.id}`, tone: 'secondary' },
        { label: '任务收件箱', to: '/vision/tasks', tone: 'ghost' }
      ],
      tone: 'success'
    };
  }

  if (!registeredVersion) {
    return {
      step: 6,
      objective: '注册可验证模型版本',
      rationale: '训练记录已经存在，但还没有 registered 模型版本可用于验证或部署。',
      primary: { label: '打开模型版本', to: '/models/versions', tone: 'primary' },
      secondary: [
        { label: '最近训练', to: `/training/jobs/${latestJob.id}`, tone: 'secondary' },
        { label: '闭环向导', to: '/workflow/closure', tone: 'ghost' }
      ],
      tone: 'warning'
    };
  }

  if (snapshot.inferenceRuns.length === 0) {
    return {
      step: 5,
      objective: '运行推理验证',
      rationale: `${registeredVersion.version_name} 已注册，下一步用真实样本验证输出质量。`,
      primary: { label: '开始验证', to: `/inference/validate?selectedVersion=${registeredVersion.id}`, tone: 'primary' },
      secondary: [
        { label: '模型版本', to: '/models/versions', tone: 'secondary' },
        { label: '数据集', to: '/datasets', tone: 'ghost' }
      ],
      tone: 'success'
    };
  }

  if (pendingApproval) {
    return {
      step: 6,
      objective: '处理发布审批',
      rationale: `审批 ${pendingApproval.id} 正在等待处理，发布链路还没有闭环。`,
      primary: { label: '打开审批', to: '/admin/models/pending', tone: 'primary' },
      secondary: [
        { label: '审计日志', to: '/admin/audit', tone: 'ghost' },
        { label: '验证报告', to: '/admin/verification-reports', tone: 'ghost' }
      ],
      tone: 'warning'
    };
  }

  if (snapshot.runtime.data?.status === 'not_ready') {
    return {
      step: 7,
      objective: '修复运行时部署能力',
      rationale: 'Runtime 当前 not_ready，部署和本地验证能力需要先恢复。',
      primary: { label: '运行时设置', to: '/settings/runtime', tone: 'primary' },
      secondary: [
        { label: 'Worker 设置', to: '/settings/workers', tone: 'secondary' },
        { label: '问 OpenClaw', to: buildChatPath('/workspace/console', '帮我诊断 Runtime not_ready 的原因。'), tone: 'ghost' }
      ],
      tone: 'danger'
    };
  }

  return {
    step: 8,
    objective: '沉淀反馈并准备下一轮',
    rationale: '数据、训练、验证和版本都有记录，现在可以从推理反馈进入下一轮数据闭环。',
    primary: { label: '查看验证结果', to: '/inference/validate', tone: 'primary' },
    secondary: [
      { label: '任务收件箱', to: '/vision/tasks', tone: 'secondary' },
      { label: '数据集', to: '/datasets', tone: 'ghost' }
    ],
    tone: 'success'
  };
};

export default function AgentTrainingStudioPage() {
  const location = useLocation();
  const [snapshot, setSnapshot] = useState<StudioSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [runtimePreparing, setRuntimePreparing] = useState(false);
  const [runtimePrepareMessage, setRuntimePrepareMessage] = useState('');
  const [runtimePrepareError, setRuntimePrepareError] = useState('');

  const currentPath = `${location.pathname}${location.search || ''}`;

  const load = useCallback(async (mode: 'initial' | 'manual' = 'initial') => {
    if (mode === 'initial') {
      setLoading(true);
    }
    if (mode === 'manual') {
      setRefreshing(true);
    }
    setError('');

    try {
      const user = await api.me();
      const [
        datasets,
        visionTasks,
        trainingJobs,
        modelVersions,
        inferenceRuns,
        approvals,
        runtime,
        workers
      ] = await Promise.all([
        settle(api.listDatasets(), []),
        settle(api.listVisionTasks(), []),
        settle(api.listTrainingJobs(), []),
        settle(api.listModelVersions(), []),
        settle(api.listInferenceRuns(), []),
        settle(api.listApprovalRequests(), []),
        settle(api.getRuntimeReadiness(), null),
        settle(api.listTrainingWorkers(), [])
      ]);

      setSnapshot({
        user,
        datasets: datasets.data,
        visionTasks: visionTasks.data,
        trainingJobs: trainingJobs.data,
        modelVersions: modelVersions.data,
        inferenceRuns: inferenceRuns.data,
        approvals: approvals.data,
        runtime,
        workers
      });
    } catch (loadError) {
      setError((loadError as Error).message);
      setSnapshot(null);
    } finally {
      if (mode === 'initial') {
        setLoading(false);
      }
      if (mode === 'manual') {
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void load('initial');
  }, [load]);

  const prepareRealRuntime = useCallback(async () => {
    setRuntimePreparing(true);
    setRuntimePrepareMessage('');
    setRuntimePrepareError('');
    try {
      const prepared = await api.prepareRealTrainingRuntimeSettings(false);
      setSnapshot((current) =>
        current
          ? {
              ...current,
              runtime: {
                data: prepared.readiness,
                error: ''
              }
            }
          : current
      );
      setRuntimePrepareMessage(
        prepared.changed_fields.length > 0
          ? `已安全准备真实 Runtime：${prepared.changed_fields.length} 项设置已更新。`
          : '真实 Runtime 设置已经符合安全基线。'
      );
    } catch (prepareError) {
      setRuntimePrepareError((prepareError as Error).message);
    } finally {
      setRuntimePreparing(false);
    }
  }, []);

  const mission = useMemo(() => (snapshot ? resolveMission(snapshot) : null), [snapshot]);

  const evidence = useMemo(() => {
    if (!snapshot) {
      return [];
    }

    const readyDatasetCount = snapshot.datasets.filter(isReadyDataset).length;
    const activeJobCount = snapshot.trainingJobs.filter((job) => activeTrainingStatuses.has(job.status)).length;
    const failedJobCount = snapshot.trainingJobs.filter((job) => job.status === 'failed').length;
    const registeredVersionCount = snapshot.modelVersions.filter((version) => version.status === 'registered').length;
    const pendingApprovalCount = snapshot.approvals.filter((approval) => approval.status === 'pending').length;
    const onlineWorkerCount = snapshot.workers.data.filter((worker) => worker.effective_status === 'online').length;

    return [
      {
        label: '数据快照',
        value: `${readyDatasetCount}/${snapshot.datasets.length}`,
        detail: readyDatasetCount > 0 ? 'ready 数据集可训练' : '需要导入或修复数据',
        tone: readyDatasetCount > 0 ? 'success' : 'warning',
        to: '/datasets'
      },
      {
        label: '训练运行',
        value: `${activeJobCount} active`,
        detail: failedJobCount > 0 ? `${failedJobCount} 个失败训练待修复` : `${snapshot.trainingJobs.length} 条训练记录`,
        tone: failedJobCount > 0 ? 'danger' : activeJobCount > 0 ? 'info' : 'neutral',
        to: '/training/jobs'
      },
      {
        label: '模型版本',
        value: `${registeredVersionCount}`,
        detail: registeredVersionCount > 0 ? 'registered 可验证' : '等待注册证据',
        tone: registeredVersionCount > 0 ? 'success' : 'warning',
        to: '/models/versions'
      },
      {
        label: '推理验证',
        value: `${snapshot.inferenceRuns.length}`,
        detail: snapshot.inferenceRuns.length > 0 ? '已有验证输出' : '需要真实样本验证',
        tone: snapshot.inferenceRuns.length > 0 ? 'success' : 'warning',
        to: '/inference/validate'
      },
      {
        label: 'Runtime',
        value: snapshot.runtime.data?.status ?? 'unknown',
        detail: snapshot.runtime.error || `${snapshot.runtime.data?.issues.length ?? 0} 个运行时问题`,
        tone: snapshot.runtime.error ? 'warning' : getRuntimeTone(snapshot.runtime.data?.status),
        to: '/settings/runtime'
      },
      {
        label: 'Workers',
        value: snapshot.workers.error ? 'restricted' : `${onlineWorkerCount}/${snapshot.workers.data.length}`,
        detail: snapshot.workers.error || '训练节点调度状态',
        tone: snapshot.workers.error ? 'warning' : onlineWorkerCount > 0 ? 'success' : 'neutral',
        to: '/settings/workers'
      },
      {
        label: '治理队列',
        value: `${pendingApprovalCount}`,
        detail: pendingApprovalCount > 0 ? '审批待处理' : '暂无阻塞审批',
        tone: pendingApprovalCount > 0 ? 'warning' : 'success',
        to: '/admin/models/pending'
      }
    ] as Array<{
      label: string;
      value: string;
      detail: string;
      tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
      to: string;
    }>;
  }, [snapshot]);

  const latestRecords = useMemo(() => {
    if (!snapshot) {
      return [];
    }
    return [
      ...sortByUpdatedDesc(snapshot.visionTasks).slice(0, 2).map((task) => ({
        id: `task-${task.id}`,
        label: 'VisionTask',
        title: task.spec.target_description || task.source_prompt || task.id,
        meta: `${task.status} · ${formatDateTime(task.updated_at)}`,
        to: `/vision/tasks/${task.id}`
      })),
      ...sortByUpdatedDesc(snapshot.trainingJobs).slice(0, 3).map((job) => ({
        id: `job-${job.id}`,
        label: 'Training',
        title: job.name,
        meta: `${job.status} · ${job.framework} · ${formatDateTime(job.updated_at)}`,
        to: `/training/jobs/${job.id}`
      })),
      ...sortByUpdatedDesc(snapshot.inferenceRuns).slice(0, 2).map((run) => ({
        id: `run-${run.id}`,
        label: 'Inference',
        title: run.id,
        meta: `${run.status} · ${run.framework} · ${formatDateTime(run.updated_at)}`,
        to: '/inference/validate'
      }))
    ].slice(0, 6);
  }, [snapshot]);

  if (loading) {
    return (
      <main className="agent-studio-page agent-studio-page--state" data-testid="agent-studio-page">
        <StateBlock
          variant="loading"
          title="正在启动 Agent Training Studio"
          description="正在读取任务、数据、训练、验证和运行时证据。"
        />
      </main>
    );
  }

  if (error || !snapshot || !mission) {
    const loginPath = `/auth/login?return_to=${encodeURIComponent(currentPath)}`;
    return (
      <main className="agent-studio-page agent-studio-page--state" data-testid="agent-studio-page">
        <StateBlock
          variant={error ? 'error' : 'empty'}
          title="Agent Training Studio 不可用"
          description={error || '没有可用的工作台快照。'}
          extra={
            <ButtonLink to={loginPath} variant="secondary" size="sm">
              登录后重试
            </ButtonLink>
          }
        />
      </main>
    );
  }

  const openClawPath = buildChatPath(
    currentPath,
    `继续处理 Agent Training Studio 当前目标：${mission.objective}`
  );

  return (
    <main className="agent-studio-page" data-testid="agent-studio-page">
      <section className="agent-studio-mission-bar" aria-label="Agent Studio mission bar">
        <ButtonLink to="/workspace/console" unstyled className="agent-studio-brand">
          <span aria-hidden="true">V</span>
          <strong>Agent Training Studio</strong>
          <small>Vistral</small>
        </ButtonLink>
        <div className="agent-studio-mission-bar__objective">
          <small>当前目标</small>
          <strong>{mission.objective}</strong>
        </div>
        <div className="agent-studio-mission-bar__status">
          <Badge tone={mission.tone}>{studioSteps[mission.step]}</Badge>
          <Badge tone={getRuntimeTone(snapshot.runtime.data?.status)}>
            Runtime {snapshot.runtime.data?.status ?? 'unknown'}
          </Badge>
          <Badge tone="neutral">{snapshot.user.username} · {snapshot.user.role}</Badge>
        </div>
      </section>

      <section className="agent-studio-layout">
        <aside className="agent-studio-flow-rail" aria-label="Agent training flow">
          <div className="agent-studio-flow-rail__header">
            <small>Agent Flow</small>
            <strong>{mission.step + 1}/{studioSteps.length}</strong>
          </div>
          <ol>
            {studioSteps.map((step, index) => (
              <li
                key={step}
                className={[
                  index < mission.step ? 'is-complete' : '',
                  index === mission.step ? 'is-active' : ''
                ].filter(Boolean).join(' ')}
              >
                <span>{index < mission.step ? '✓' : index + 1}</span>
                <strong>{step}</strong>
              </li>
            ))}
          </ol>
          <ButtonLink to={openClawPath} variant="secondary" size="sm" block>
            问 OpenClaw
          </ButtonLink>
        </aside>

        <section className="agent-studio-workbench">
          <ProgressStepper
            steps={studioSteps}
            current={mission.step}
            title="训练闭环进度"
            caption={`${mission.step + 1}/${studioSteps.length} · ${mission.rationale}`}
            className="agent-studio-stepper"
          />

          <section className="agent-studio-next-action" aria-label="Recommended next action">
            <div>
              <small>推荐下一步</small>
              <h1>{mission.objective}</h1>
              <p>{mission.rationale}</p>
            </div>
            <div className="agent-studio-next-action__actions">
              <ButtonLink to={mission.primary.to} variant={mission.primary.tone} size="md">
                {mission.primary.label}
              </ButtonLink>
              {mission.secondary.map((action) => (
                <ButtonLink key={`${action.label}-${action.to}`} to={action.to} variant={action.tone} size="sm">
                  {action.label}
                </ButtonLink>
              ))}
              <Button type="button" variant="ghost" size="sm" onClick={() => load('manual')} disabled={refreshing}>
                {refreshing ? '刷新中...' : '刷新证据'}
              </Button>
            </div>
          </section>

          {mission.delivery ? (
            <section className="agent-studio-delivery-card" aria-label="Agent delivery readiness">
              <div className="agent-studio-section-header">
                <small>Agent Delivery</small>
                <strong>真实模型交付门禁</strong>
              </div>
              <div className="agent-studio-delivery-card__summary">
                <Badge
                  tone={
                    mission.delivery.status === 'ready'
                      ? 'success'
                      : mission.delivery.status === 'blocked'
                        ? 'danger'
                        : 'warning'
                  }
                >
                  {mission.delivery.status}
                </Badge>
                <p>{mission.delivery.summary}</p>
              </div>
              {mission.delivery.blockers.length > 0 ? (
                <ul>
                  {mission.delivery.blockers.slice(0, 4).map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              ) : null}
              {mission.delivery.commands.length > 0 ? (
                <div className="agent-studio-delivery-card__commands">
                  {mission.delivery.commands.slice(0, 3).map((command) => (
                    <code key={command}>{command}</code>
                  ))}
                </div>
              ) : null}
              <div className="agent-studio-delivery-card__actions">
                {snapshot.user.role === 'admin' ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void prepareRealRuntime()}
                    disabled={runtimePreparing || refreshing}
                  >
                    {runtimePreparing ? '准备中...' : 'Prepare real runtime'}
                  </Button>
                ) : (
                  <span>需要管理员准备真实 Runtime 设置。</span>
                )}
                <ButtonLink to="/settings/runtime?focus=readiness" variant="ghost" size="sm">
                  打开 Runtime 设置
                </ButtonLink>
              </div>
              {runtimePrepareMessage ? (
                <small className="agent-studio-delivery-card__note">{runtimePrepareMessage}</small>
              ) : null}
              {runtimePrepareError ? (
                <small className="agent-studio-delivery-card__error">{runtimePrepareError}</small>
              ) : null}
            </section>
          ) : null}

          <section className="agent-studio-evidence-board" aria-label="Evidence board">
            {evidence.map((item) => (
              <ButtonLink
                key={item.label}
                to={item.to}
                unstyled
                className={`agent-studio-evidence-item tone-${item.tone}`}
              >
                <small>{item.label}</small>
                <strong>{item.value}</strong>
                <span>{item.detail}</span>
              </ButtonLink>
            ))}
          </section>

          <section className="agent-studio-record-stream" aria-label="Latest evidence">
            <div className="agent-studio-section-header">
              <small>最近证据</small>
              <strong>任务、训练和验证记录</strong>
            </div>
            {latestRecords.length > 0 ? (
              <ol>
                {latestRecords.map((record) => (
                  <li key={record.id}>
                    <ButtonLink to={record.to} unstyled className="agent-studio-record-link">
                      <Badge tone="info">{record.label}</Badge>
                      <strong>{record.title}</strong>
                      <small>{record.meta}</small>
                    </ButtonLink>
                  </li>
                ))}
              </ol>
            ) : (
              <StateBlock
                variant="empty"
                title="还没有证据流"
                description="导入数据或创建视觉任务后，这里会显示最新记录。"
              />
            )}
          </section>
        </section>

        <aside className="agent-studio-context-panel" aria-label="Context panel">
          <section>
            <div className="agent-studio-section-header">
              <small>OpenClaw</small>
              <strong>上下文助手</strong>
            </div>
            <p>
              我会带着当前目标、阶段和证据进入对话，不会丢掉你正在处理的训练闭环。
            </p>
            <ButtonLink to={openClawPath} variant="primary" size="sm" block>
              继续对话
            </ButtonLink>
          </section>
          <section>
            <div className="agent-studio-section-header">
              <small>Readiness</small>
              <strong>运行与调度</strong>
            </div>
            <dl className="agent-studio-readiness-list">
              <div>
                <dt>Runtime</dt>
                <dd><StatusTag status={snapshot.runtime.data?.status ?? 'unknown'} /></dd>
              </div>
              <div>
                <dt>Issues</dt>
                <dd>{snapshot.runtime.data?.issues.length ?? (snapshot.runtime.error ? 'restricted' : 0)}</dd>
              </div>
              <div>
                <dt>Workers</dt>
                <dd>{snapshot.workers.error ? 'restricted' : snapshot.workers.data.length}</dd>
              </div>
            </dl>
          </section>
          <section>
            <div className="agent-studio-section-header">
              <small>Fast paths</small>
              <strong>主流程入口</strong>
            </div>
            <div className="agent-studio-link-list">
              <ButtonLink to="/vision/tasks" variant="ghost" size="sm">任务收件箱</ButtonLink>
              <ButtonLink to="/datasets" variant="ghost" size="sm">数据集</ButtonLink>
              <ButtonLink to="/training/jobs/new" variant="ghost" size="sm">启动训练</ButtonLink>
              <ButtonLink to="/inference/validate" variant="ghost" size="sm">推理验证</ButtonLink>
              <ButtonLink to="/models/versions" variant="ghost" size="sm">模型版本</ButtonLink>
              <ButtonLink to="/settings/runtime" variant="ghost" size="sm">运行时</ButtonLink>
            </div>
          </section>
        </aside>
      </section>
    </main>
  );
}
