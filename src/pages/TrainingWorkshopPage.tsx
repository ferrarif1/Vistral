import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import DatasetSelector from '../components/workshop/DatasetSelector';
import ModelSelector from '../components/workshop/ModelSelector';
import StageTimeline from '../components/workshop/StageTimeline';
import WorkshopScene from '../components/workshop/WorkshopScene';
import WorkshopStatusPanel from '../components/workshop/WorkshopStatusPanel';
import { Button, ButtonLink } from '../components/ui/Button';
import {
  automaticDemoSequence,
  buildMockValidationMetrics,
  defaultWorkshopMetrics,
  demoDatasets,
  mockWorkshopTask,
  modelCharacters,
  workshopStages,
  type WorkshopCharacterId,
  type WorkshopStageId
} from '../data/workshopDemoData';

const stageEvents: Record<WorkshopStageId, string> = {
  idle: '训练工坊已就绪。',
  dataset_selecting: '正在挑选训练数据集。',
  dataset_preparing: '样本箱、相册和录像带正在入库。',
  labeling_or_reviewing: '正在检查标签覆盖和审核结果。',
  training: '模型角色正在训练台前学习数据。',
  tuning: '参数面板已打开，正在微调学习策略。',
  inference_validating: '推理验证室已准备，请选择验证数据集。',
  human_review_required: '验证结果已生成，等待人工确认。',
  publishing: '发布前检查通过，正在生成版本徽章。',
  completed: '训练、验证和发布闭环已完成。',
  failed: '训练过程需要返工，请查看日志并重试。'
};

const getCharacter = (characterId: WorkshopCharacterId) =>
  modelCharacters.find((character) => character.id === characterId) ?? modelCharacters[0];

const scopedWorkshopNavKeys = [
  'dataset',
  'version',
  'task_type',
  'framework',
  'execution_target',
  'worker',
  'return_to'
] as const;

const buildScopedWorkshopPath = (basePath: string, currentSearch: string): string => {
  const sourceParams = new URLSearchParams(currentSearch);
  const [pathname, query = ''] = basePath.split('?');
  const targetParams = new URLSearchParams(query);
  scopedWorkshopNavKeys.forEach((key) => {
    const value = sourceParams.get(key)?.trim();
    if (value && !targetParams.has(key)) {
      targetParams.set(key, value);
    }
  });
  const nextQuery = targetParams.toString();
  return nextQuery ? `${pathname}?${nextQuery}` : pathname;
};

const validationDatasetUpdatedEvent = '验证数据集已更新，等待开始考试。';

export default function TrainingWorkshopPage() {
  const location = useLocation();
  const [stage, setStage] = useState<WorkshopStageId>(mockWorkshopTask.stage);
  const [characterId, setCharacterId] = useState<WorkshopCharacterId>(mockWorkshopTask.characterId);
  const [datasetId, setDatasetId] = useState(mockWorkshopTask.datasetId);
  const [validationDatasetId, setValidationDatasetId] = useState(mockWorkshopTask.validationDatasetId);
  const [round, setRound] = useState(mockWorkshopTask.round);
  const [progress, setProgress] = useState(mockWorkshopTask.progress);
  const [metrics, setMetrics] = useState(mockWorkshopTask.metrics);
  const [latestEvent, setLatestEvent] = useState(mockWorkshopTask.latestEvent);
  const [autoDemoRunning, setAutoDemoRunning] = useState(false);
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  const character = getCharacter(characterId);
  const dataset = useMemo(
    () => demoDatasets.find((item) => item.id === datasetId) ?? demoDatasets[0],
    [datasetId]
  );
  const validationDataset = useMemo(
    () => demoDatasets.find((item) => item.id === validationDatasetId) ?? dataset,
    [dataset, validationDatasetId]
  );
  const trainingJobsPath = useMemo(
    () => buildScopedWorkshopPath('/training/jobs', location.search),
    [location.search]
  );
  const trainingJobCreatePath = useMemo(
    () => buildScopedWorkshopPath('/training/jobs/new', location.search),
    [location.search]
  );
  const examMode = stage === 'inference_validating';

  const clearTimers = useCallback(() => {
    timersRef.current.forEach((timer) => clearTimeout(timer));
    timersRef.current = [];
  }, []);

  const schedule = useCallback((callback: () => void, delay: number) => {
    const timer = setTimeout(callback, delay);
    timersRef.current.push(timer);
  }, []);

  const moveToStage = useCallback((nextStage: WorkshopStageId, eventOverride?: string) => {
    setStage(nextStage);
    setLatestEvent(eventOverride ?? stageEvents[nextStage]);

    if (nextStage === 'training') {
      setProgress((current) => Math.max(current, 18));
    }
    if (nextStage === 'tuning') {
      setProgress((current) => Math.max(current, 72));
    }
    if (nextStage === 'inference_validating') {
      setProgress(100);
    }
    if (nextStage === 'failed') {
      setAutoDemoRunning(false);
    }
  }, []);

  useEffect(
    () => () => {
      clearTimers();
    },
    [clearTimers]
  );

  useEffect(() => {
    if (stage !== 'training' && stage !== 'tuning') {
      return;
    }

    const interval = setInterval(() => {
      setProgress((current) => {
        const next = current + (stage === 'training' ? 7 : 3);
        return Math.min(next, stage === 'training' ? 82 : 96);
      });
    }, 600);

    return () => clearInterval(interval);
  }, [stage]);

  const handleCharacterSelect = useCallback((nextCharacterId: WorkshopCharacterId) => {
    setCharacterId(nextCharacterId);
    setLatestEvent(`已切换为 ${getCharacter(nextCharacterId).name}，当前阶段保持不变。`);
  }, []);

  const handleDatasetSelect = useCallback(
    (nextDatasetId: string) => {
      clearTimers();
      setDatasetId(nextDatasetId);
      setValidationDatasetId(nextDatasetId);
      setMetrics(defaultWorkshopMetrics);
      setProgress(0);
      setAutoDemoRunning(false);
      moveToStage('dataset_selecting', '已选择数据集，角色正在前往数据集仓库。');
      schedule(() => moveToStage('dataset_preparing'), 850);
    },
    [clearTimers, moveToStage, schedule]
  );

  const handleAutoSelectValidationDataset = useCallback(() => {
    const recommended =
      demoDatasets.find((item) => item.recommendedFor.includes(characterId)) ?? demoDatasets[0];
    setValidationDatasetId(recommended.id);
    setLatestEvent(`已自动选择验证数据集：${recommended.name}。`);
  }, [characterId]);

  const handleStartExam = useCallback(() => {
    clearTimers();
    setAutoDemoRunning(false);
    moveToStage('inference_validating', '模型角色进入推理验证室，考试中。');
    schedule(() => {
      setMetrics(buildMockValidationMetrics(validationDatasetId));
      moveToStage('human_review_required');
    }, 2400);
  }, [clearTimers, moveToStage, schedule, validationDatasetId]);

  const handleApprovePublish = useCallback(() => {
    clearTimers();
    moveToStage('publishing');
    schedule(() => {
      setProgress(100);
      moveToStage('completed');
      setAutoDemoRunning(false);
    }, 1800);
  }, [clearTimers, moveToStage, schedule]);

  const handleReturnTraining = useCallback(() => {
    clearTimers();
    setRound((current) => current + 1);
    setProgress(16);
    setMetrics(defaultWorkshopMetrics);
    setAutoDemoRunning(false);
    moveToStage('training', '人工确认未通过，已退回训练实验室。');
  }, [clearTimers, moveToStage]);

  const handleReselectDataset = useCallback(() => {
    clearTimers();
    setMetrics(defaultWorkshopMetrics);
    setAutoDemoRunning(false);
    moveToStage('inference_validating', '请重新选择验证数据集。');
  }, [clearTimers, moveToStage]);

  const handleRetry = useCallback(() => {
    setRound((current) => current + 1);
    setProgress(10);
    setMetrics(defaultWorkshopMetrics);
    moveToStage('training', '已重新启动训练轮次。');
  }, [moveToStage]);

  const handleAutoDemo = useCallback(() => {
    clearTimers();
    setAutoDemoRunning(true);
    setRound(3);
    setProgress(0);
    setMetrics(defaultWorkshopMetrics);
    setDatasetId(demoDatasets[0].id);
    setValidationDatasetId(demoDatasets[0].id);

    automaticDemoSequence.forEach((nextStage, index) => {
      schedule(() => {
        moveToStage(nextStage);
        if (nextStage === 'human_review_required') {
          setMetrics(buildMockValidationMetrics(demoDatasets[0].id));
          setAutoDemoRunning(false);
        }
      }, index * 2300);
    });
  }, [clearTimers, moveToStage, schedule]);

  const stageConfig = workshopStages[stage];

  return (
    <main className="training-workshop-page">
      <section className="training-workshop-hero">
        <div>
          <small>模型训练流程</small>
          <h1>Vistral 像素训练工坊</h1>
          <p>
            用一个活动模型角色串起数据集选择、训练调参、推理考试和人工确认。
            高风险发布动作仍然需要显式确认。
          </p>
        </div>
        <div className="training-workshop-hero__actions">
          <Button type="button" variant="primary" size="sm" onClick={handleAutoDemo} disabled={autoDemoRunning}>
            {autoDemoRunning ? '演示中...' : '自动演示流程'}
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => moveToStage('failed')}>
            模拟失败
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => moveToStage('idle')}>
            重置待命
          </Button>
          <ButtonLink to={trainingJobCreatePath} variant="ghost" size="sm">
            打开真实训练创建
          </ButtonLink>
        </div>
      </section>

      <section className="training-workshop-layout">
        <div className="training-workshop-layout__scene">
          <WorkshopScene
            stage={stage}
            character={character}
            dataset={validationDataset}
            progress={progress}
            round={round}
          />
        </div>
        <WorkshopStatusPanel
          taskName={mockWorkshopTask.name}
          stage={stage}
          character={character}
          dataset={dataset}
          validationDataset={validationDataset}
          round={round}
          progress={progress}
          metrics={metrics}
          latestEvent={latestEvent}
          trainingJobsPath={trainingJobsPath}
          onApprovePublish={handleApprovePublish}
          onReturnTraining={handleReturnTraining}
          onReselectDataset={handleReselectDataset}
          onRetry={handleRetry}
        />
      </section>

      <StageTimeline stage={stage} />

      <section className="training-workshop-selectors">
        <ModelSelector
          characters={modelCharacters}
          selectedId={characterId}
          onSelect={handleCharacterSelect}
        />
        <DatasetSelector
          datasets={demoDatasets}
          selectedDatasetId={datasetId}
          validationDatasetId={validationDatasetId}
          characterId={characterId}
          examMode={examMode}
          onSelectDataset={handleDatasetSelect}
          onSelectValidationDataset={(nextDatasetId) => {
            setValidationDatasetId(nextDatasetId);
            setLatestEvent(validationDatasetUpdatedEvent);
          }}
          onAutoSelectValidationDataset={handleAutoSelectValidationDataset}
          onStartExam={handleStartExam}
        />
      </section>

      <p className="training-workshop-footnote">
        当前阶段：{stageConfig.label}。该入口用于快速理解训练闭环；执行真实任务请进入训练创建和训练任务页。
      </p>
    </main>
  );
}
