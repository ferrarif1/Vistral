import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import GameWorkshopAssistant from '../components/game-workshop/GameWorkshopAssistant';
import GameWorkshopRoom from '../components/game-workshop/GameWorkshopRoom';
import GameWorkshopTimeline from '../components/game-workshop/GameWorkshopTimeline';
import StateBlock from '../components/StateBlock';
import { Badge } from '../components/ui/Badge';
import { ButtonLink } from '../components/ui/Button';
import { Drawer } from '../components/ui/Overlay';
import ProgressStepper from '../components/ui/ProgressStepper';
import useBackgroundPolling from '../hooks/useBackgroundPolling';
import { useI18n } from '../i18n/I18nProvider';
import {
  loadGameWorkshopSnapshot,
  type GameWorkshopRoomId,
  type GameWorkshopSnapshot
} from '../features/gameWorkshopSnapshot';
import {
  getPixelWorkshopRoomAsset,
  pixelWorkshopFurnitureAssets,
  pixelWorkshopHouseAssets
} from '../features/pixelWorkshopAssets';

const pixelScopedNavKeys = [
  'dataset',
  'version',
  'task_type',
  'framework',
  'execution_target',
  'worker',
  'return_to'
] as const;

const buildScopedPixelPath = (basePath: string, currentSearch: string): string => {
  const sourceParams = new URLSearchParams(currentSearch);
  const [pathname, query = ''] = basePath.split('?');
  const targetParams = new URLSearchParams(query);
  pixelScopedNavKeys.forEach((key) => {
    const value = sourceParams.get(key)?.trim();
    if (value && !targetParams.has(key)) {
      targetParams.set(key, value);
    }
  });
  const nextQuery = targetParams.toString();
  return nextQuery ? `${pathname}?${nextQuery}` : pathname;
};

const activeRoomPriority: GameWorkshopRoomId[] = [
  'reception',
  'training',
  'exam',
  'annotation',
  'recipes',
  'publish',
  'runtime',
  'bugs',
  'datasets'
];

const coreRoomIds: GameWorkshopRoomId[] = [
  'reception',
  'datasets',
  'annotation',
  'recipes',
  'training',
  'exam',
  'publish',
  'runtime',
  'bugs'
];

const resolveInitialRoom = (snapshot: GameWorkshopSnapshot): GameWorkshopRoomId => {
  const coreRooms = snapshot.rooms.filter((room) => coreRoomIds.includes(room.id));
  for (const roomId of activeRoomPriority) {
    const room = coreRooms.find((entry) => entry.id === roomId);
    if (!room) {
      continue;
    }
    if (
      room.badges.some((badge) => badge.tone === 'warning' || badge.tone === 'danger') ||
      room.id === 'training'
    ) {
      return room.id;
    }
  }
  return coreRooms[0]?.id ?? 'datasets';
};

export default function PixelLabPage() {
  const { t } = useI18n();
  const location = useLocation();
  const [snapshot, setSnapshot] = useState<GameWorkshopSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeRoomId, setActiveRoomId] = useState<GameWorkshopRoomId>('datasets');
  const [drawerRoomId, setDrawerRoomId] = useState<GameWorkshopRoomId | null>(null);

  const loadSnapshot = async (mode: 'initial' | 'background' = 'initial') => {
    if (mode === 'initial') {
      setLoading(true);
    }
    try {
      const nextSnapshot = await loadGameWorkshopSnapshot();
      setSnapshot(nextSnapshot);
      setError('');
      setActiveRoomId((previous) => {
        const stillVisible = nextSnapshot.rooms.some((room) => room.id === previous);
        return stillVisible ? previous : resolveInitialRoom(nextSnapshot);
      });
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      if (mode === 'initial') {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    void loadSnapshot('initial');
  }, []);

  useBackgroundPolling(
    () => loadSnapshot('background'),
    {
      intervalMs: 15000,
      enabled: true
    }
  );

  const scopedSnapshot = useMemo(() => {
    if (!snapshot) {
      return null;
    }
    return {
      ...snapshot,
      rooms: snapshot.rooms.map((room) => ({
        ...room,
        href: buildScopedPixelPath(room.href, location.search)
      })),
      timeline: snapshot.timeline.map((event) => ({
        ...event,
        href: buildScopedPixelPath(event.href, location.search)
      })),
      modelRoles: snapshot.modelRoles.map((role) => ({
        ...role,
        href: buildScopedPixelPath(role.href, location.search)
      })),
      assistantSuggestionsByRoom: Object.fromEntries(
        Object.entries(snapshot.assistantSuggestionsByRoom).map(([roomId, suggestions]) => [
          roomId,
          suggestions.map((suggestion) => ({
            ...suggestion,
            href: buildScopedPixelPath(suggestion.href, location.search)
          }))
        ])
      ) as GameWorkshopSnapshot['assistantSuggestionsByRoom']
    };
  }, [location.search, snapshot]);

  const coreRooms = useMemo(
    () =>
      scopedSnapshot?.rooms
        .filter((room) => coreRoomIds.includes(room.id))
        .map((room, index) => ({
          ...room,
          number: index + 1
        })) ?? [],
    [scopedSnapshot]
  );
  const activeRoom = coreRooms.find((room) => room.id === activeRoomId) ?? coreRooms[0] ?? null;
  const drawerRoom = drawerRoomId
    ? coreRooms.find((room) => room.id === drawerRoomId) ?? null
    : null;
  const activeRoomIndex = activeRoom ? coreRooms.findIndex((room) => room.id === activeRoom.id) : -1;
  const currentStepIndex = Math.max(activeRoomIndex, 0);
  const stepperSteps = coreRooms.map((room) => room.title);
  const stepperCaption =
    coreRooms.length > 0
      ? `当前 ${currentStepIndex + 1}/${coreRooms.length} · ${activeRoom?.subtitle ?? '等待房间状态'}`
      : '等待房间状态';
  const drawerRoomAsset = drawerRoom ? getPixelWorkshopRoomAsset(drawerRoom.id) : undefined;
  const activeModelRole = scopedSnapshot?.modelRoles[0] ?? null;
  const currentProjectName = activeModelRole?.name ?? scopedSnapshot?.modelVersions[0]?.version_name ?? 'Vistral-7B OCR 训练闭环';
  const assistantSuggestions =
    (scopedSnapshot?.assistantSuggestionsByRoom[activeRoomId] ?? []).slice(0, 3);
  const activeRoomChatPath = useMemo(() => {
    const params = new URLSearchParams(location.search);
    params.set('room', activeRoomId);
    params.set('return_to', '/workspace/pixel-lab');
    params.set('prompt', `继续处理${activeRoom?.title ?? '训练之家'}的下一步。`);
    return `/workspace/chat?${params.toString()}`;
  }, [activeRoom?.title, activeRoomId, location.search]);
  const agentEvidenceBadges = (activeRoom?.badges ?? []).slice(0, 3);
  const agentDecisionCopy =
    activeRoom?.details[0] ?? activeRoom?.summary ?? 'OpenClaw 会基于当前房间状态给出下一步。';
  const modelRolesByRoom = useMemo(() => {
    const rolesByRoom = new Map<GameWorkshopRoomId, GameWorkshopSnapshot['modelRoles']>();
    scopedSnapshot?.modelRoles.forEach((role) => {
      const current = rolesByRoom.get(role.roomId) ?? [];
      rolesByRoom.set(role.roomId, [...current, role]);
    });
    return rolesByRoom;
  }, [scopedSnapshot?.modelRoles]);
  const trainingRoleCount = modelRolesByRoom.get('training')?.length ?? 0;
  const examRoleCount = modelRolesByRoom.get('exam')?.length ?? 0;
  const workshopCallout = `有 ${trainingRoleCount} 个模型正在训练，${examRoleCount} 个模型正在考试，快来指挥你的模型军团吧！`;

  useEffect(() => {
    if (!drawerRoomId) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDrawerRoomId(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawerRoomId]);

  if (loading) {
    return (
      <main className="game-workshop-page game-workshop-page--state">
        <StateBlock
          variant="loading"
          title={t('正在加载训练之家')}
          description={t('正在读取数据集、模型、训练、推理和运行状态。')}
        />
      </main>
    );
  }

  if (error || !scopedSnapshot) {
    return (
      <main className="game-workshop-page game-workshop-page--state">
        <StateBlock
          variant="error"
          title={t('训练之家不可用')}
          description={error || t('无法读取当前状态')}
          extra={
            <ButtonLink to={buildScopedPixelPath('/workspace/console', location.search)} variant="secondary" size="sm">
              返回控制台
            </ButtonLink>
          }
        />
      </main>
    );
  }

  return (
    <main className="game-workshop-page">
      <section className="game-workshop-shell">
        <aside className="game-workshop-overview game-workshop-left-rail">
          <section className="game-workshop-card">
            <div className="game-workshop-card__header">
              <strong>整体概览</strong>
              <small>项目总览</small>
            </div>
            <p className="game-workshop-copy">
              {currentProjectName} 正在通过数据、标注、训练、考试和发布形成闭环。
            </p>
            <div className="game-workshop-overview__badges">
              <Badge tone="info">房间 9</Badge>
              <Badge tone="success">模型角色 {scopedSnapshot.modelRoles.length}</Badge>
              <Badge tone={scopedSnapshot.runtimeReadiness?.status === 'ready' ? 'success' : 'warning'}>
                Runtime {scopedSnapshot.runtimeReadiness?.status ?? 'unknown'}
              </Badge>
            </div>
          </section>

          <section className="game-workshop-card">
            <div className="game-workshop-card__header">
              <strong>核心房间</strong>
              <small>全部入口</small>
            </div>
            <ol className="game-workshop-room-list">
              {coreRooms.map((room) => (
                <li key={room.id}>
                  <button
                    type="button"
                    className={`game-workshop-room-list__item${room.id === activeRoomId ? ' is-active' : ''}`}
                    onClick={() => setActiveRoomId(room.id)}
                  >
                    <span>{room.number}</span>
                    <strong>{room.title}</strong>
                    <small>{room.subtitle}</small>
                  </button>
                </li>
              ))}
            </ol>
          </section>

          <section className="game-workshop-card">
            <div className="game-workshop-card__header">
              <strong>角色状态</strong>
              <small>模型角色</small>
            </div>
            {activeModelRole ? (
              <ButtonLink to={activeModelRole.href} variant="ghost" size="sm" className="game-workshop-role-mini">
                <span className={`game-role-avatar persona-${activeModelRole.persona}`} aria-hidden="true" />
                <span>
                  <strong>{activeModelRole.name}</strong>
                  <small>{activeModelRole.statusLabel}</small>
                </span>
              </ButtonLink>
            ) : (
              <p className="game-workshop-empty">当前还没有活跃模型。</p>
            )}
            <div className="game-workshop-role-legend" aria-label="角色状态示例">
              {[
                ['学习中', 'engineer'],
                ['训练中', 'engineer'],
                ['考试中', 'exam'],
                ['已毕业', 'publish'],
                ['待修复', 'repair']
              ].map(([label, persona]) => (
                <span key={label}>
                  <i className={`game-role-avatar persona-${persona}`} aria-hidden="true" />
                  {label}
                </span>
              ))}
            </div>
          </section>
        </aside>

        <section className="game-workshop-main">
          <section className="game-workshop-hero">
            <div className="game-workshop-hero__brand">
              <strong>Vistral 模型训练工坊</strong>
              <small>v0.2</small>
            </div>
            <img
              className="game-workshop-hero__building game-workshop-hero__building--left"
              src={pixelWorkshopHouseAssets.window}
              alt=""
              aria-hidden="true"
              loading="lazy"
              decoding="async"
            />
            <div className="game-workshop-hero__callout" aria-live="polite">
              <span className="game-workshop-hero__crab" aria-hidden="true" />
              <strong>{workshopCallout}</strong>
            </div>
            <img
              className="game-workshop-hero__building game-workshop-hero__building--right"
              src={pixelWorkshopHouseAssets.planter}
              alt=""
              aria-hidden="true"
              loading="lazy"
              decoding="async"
            />
            <div className="game-workshop-hero__meta">
              <Badge tone="neutral">{new Date(scopedSnapshot.generatedAt).toLocaleDateString()} {new Date(scopedSnapshot.generatedAt).toLocaleTimeString()}</Badge>
              <Badge tone="success">服务 {scopedSnapshot.runtimeReadiness?.status ?? 'unknown'}</Badge>
            </div>
          </section>

          <ProgressStepper
            steps={stepperSteps}
            current={currentStepIndex}
            title="Agent 训练流程"
            caption={stepperCaption}
            className="game-workshop-top-stepper"
          />

          <section className="game-workshop-house game-workshop-house--core" aria-label="模型训练之家">
            <img className="game-workshop-house__building game-workshop-house__building--facade" src={pixelWorkshopHouseAssets.facade} alt="" aria-hidden="true" />
            <img className="game-workshop-house__building game-workshop-house__building--roof" src={pixelWorkshopHouseAssets.roof} alt="" aria-hidden="true" />
            <img className="game-workshop-house__building game-workshop-house__building--roof-tiles" src={pixelWorkshopHouseAssets.roofTiles} alt="" aria-hidden="true" />
            <img className="game-workshop-house__building game-workshop-house__building--ridge" src={pixelWorkshopHouseAssets.ridge} alt="" aria-hidden="true" />
            <img className="game-workshop-house__building game-workshop-house__building--supports-left" src={pixelWorkshopHouseAssets.supports} alt="" aria-hidden="true" />
            <img className="game-workshop-house__building game-workshop-house__building--supports-right" src={pixelWorkshopHouseAssets.supports} alt="" aria-hidden="true" />
            <img className="game-workshop-house__building game-workshop-house__building--porch" src={pixelWorkshopHouseAssets.porch} alt="" aria-hidden="true" />
            <img className="game-workshop-house__building game-workshop-house__building--chimney" src={pixelWorkshopHouseAssets.chimney} alt="" aria-hidden="true" />
            <img className="game-workshop-house__building game-workshop-house__building--awning" src={pixelWorkshopHouseAssets.awning} alt="" aria-hidden="true" />
            <img className="game-workshop-house__building game-workshop-house__building--planter" src={pixelWorkshopHouseAssets.planter} alt="" aria-hidden="true" />
            <img className="game-workshop-house__building game-workshop-house__building--plant" src={pixelWorkshopFurnitureAssets.plant} alt="" aria-hidden="true" />
            <img className="game-workshop-house__frame" src={pixelWorkshopHouseAssets.frame} alt="" aria-hidden="true" />
            {coreRooms.map((room) => (
              <div
                key={room.id}
                className={`game-workshop-house__slot game-workshop-house__slot--${room.id}`}
              >
                <GameWorkshopRoom
                  room={room}
                  active={room.id === activeRoomId}
                  modelRoles={modelRolesByRoom.get(room.id) ?? []}
                  onFocusRoom={() => setActiveRoomId(room.id)}
                  onOpenDetails={() => {
                    setActiveRoomId(room.id);
                    setDrawerRoomId(room.id);
                  }}
                />
              </div>
            ))}
          </section>

          <section className="game-workshop-bottom-workbench game-workshop-bottom-workbench--prototype" aria-label="模型训练工坊底部状态栏">
            <section className="game-workshop-card game-workshop-card--compact">
              <div className="game-workshop-card__header">
                <strong>模型角色动态</strong>
                <small>{scopedSnapshot.modelRoles.length} 个</small>
              </div>
              <div className="game-workshop-roles game-workshop-roles--compact">
                {scopedSnapshot.modelRoles.slice(0, 4).map((role) => (
                  <ButtonLink key={role.id} to={role.href} variant="ghost" size="sm" className="game-workshop-role">
                    <span className={`game-role-avatar persona-${role.persona}`} aria-hidden="true" />
                    <span className="game-workshop-role__copy">
                      <strong>{role.name}</strong>
                      <small>{role.statusLabel} · {role.subtitle}</small>
                    </span>
                  </ButtonLink>
                ))}
                {scopedSnapshot.modelRoles.length === 0 ? (
                  <p className="game-workshop-empty">当前还没有模型角色动态。</p>
                ) : null}
              </div>
            </section>

            <section className="game-workshop-card game-workshop-card--compact">
              <div className="game-workshop-card__header">
                <strong>工坊时间线</strong>
                <small>{scopedSnapshot.timeline.length} 条</small>
              </div>
              <GameWorkshopTimeline events={scopedSnapshot.timeline.slice(0, 4)} />
            </section>

            <section className="game-workshop-card game-workshop-card--compact">
              <div className="game-workshop-card__header">
                <strong>工坊资源监控</strong>
                <small>实时</small>
              </div>
              <div className="game-workshop-metrics game-workshop-metrics--compact">
                {scopedSnapshot.resources.slice(0, 4).map((metric) => (
                  <div key={`bottom-${metric.id}`} className="game-workshop-metric">
                    <div className="game-workshop-metric__header">
                      <span>{metric.label}</span>
                      <strong>{metric.valueLabel}</strong>
                    </div>
                    <div className="game-workshop-metric__bar">
                      <span className={`tone-${metric.tone}`} style={{ width: `${metric.percent}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="game-workshop-card game-workshop-card--compact">
              <div className="game-workshop-card__header">
                <strong>昨日工作小记</strong>
                <small>记录</small>
              </div>
              <ul className="game-workshop-notes game-workshop-notes--compact">
                {scopedSnapshot.dailyNotes.slice(0, 4).map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </section>
          </section>
        </section>

        <aside className="game-workshop-right-rail">
          <GameWorkshopAssistant
            activeRoomId={activeRoomId}
            activeRoom={activeRoom}
            messages={scopedSnapshot.assistantMessages}
            suggestions={assistantSuggestions}
            variant="docked"
          />

          <section className="game-workshop-card">
            <div className="game-workshop-card__header">
              <strong>成员栏 / 模型角色</strong>
              <small>{scopedSnapshot.workers.length} 个 worker</small>
            </div>
            <div className="game-workshop-member-grid">
              {scopedSnapshot.modelRoles.slice(0, 5).map((role) => (
                <ButtonLink key={`member-${role.id}`} to={role.href} variant="ghost" size="sm" className="game-workshop-member">
                  <span className={`game-role-avatar persona-${role.persona}`} aria-hidden="true" />
                  <span>
                    <strong>{role.statusLabel}</strong>
                    <small>{role.name}</small>
                  </span>
                </ButtonLink>
              ))}
              {scopedSnapshot.workers.slice(0, 3).map((worker) => (
                <ButtonLink key={`worker-${worker.id}`} to="/settings/workers" variant="ghost" size="sm" className="game-workshop-member">
                  <span className="game-role-avatar persona-repair" aria-hidden="true" />
                  <span>
                    <strong>{worker.name}</strong>
                    <small>{worker.effective_status}</small>
                  </span>
                </ButtonLink>
              ))}
            </div>
          </section>

          <section className="game-workshop-card game-agent-mission">
            <div className="game-workshop-card__header">
              <strong>Agent 下一步</strong>
              <small>{activeRoom?.title ?? '当前房间'}</small>
            </div>
            <div className="game-agent-mission__progress" aria-label="Agent 阶段进度">
              {coreRooms.map((room, index) => (
                <span
                  key={`agent-step-${room.id}`}
                  className={[
                    'game-agent-mission__step',
                    index < activeRoomIndex ? 'is-complete' : '',
                    room.id === activeRoom?.id ? 'is-current' : ''
                  ].filter(Boolean).join(' ')}
                  title={room.title}
                >
                  {room.number}
                </span>
              ))}
            </div>
            <p className="game-agent-mission__decision">{agentDecisionCopy}</p>
            <div className="game-agent-mission__evidence" aria-label="当前证据">
              {agentEvidenceBadges.length > 0 ? (
                agentEvidenceBadges.map((badge) => (
                  <Badge key={`agent-${activeRoom?.id}-${badge.label}`} tone={badge.tone ?? 'neutral'}>
                    {badge.label}: {badge.value}
                  </Badge>
                ))
              ) : (
                <Badge tone="neutral">等待房间状态</Badge>
              )}
            </div>
            <div className="game-agent-mission__actions">
              {activeRoom ? (
                <ButtonLink to={activeRoom.href} variant="primary" size="sm">
                  {activeRoom.primaryActionLabel}
                </ButtonLink>
              ) : null}
              <ButtonLink to={activeRoomChatPath} variant="ghost" size="sm">
                问 OpenClaw
              </ButtonLink>
            </div>
            <ul className="game-agent-mission__notes" aria-label="Agent 观察">
              {(activeRoom?.details ?? []).slice(1, 3).map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
              {(activeRoom?.details ?? []).length <= 1 ? (
                <li>{activeRoom?.summary ?? '当前房间暂无补充观察。'}</li>
              ) : null}
            </ul>
          </section>
        </aside>

      </section>

      <Drawer
        open={Boolean(drawerRoom)}
        side="right"
        title={drawerRoom?.title ?? '房间详情'}
        className="game-room-drawer"
        onClose={() => setDrawerRoomId(null)}
      >
        {drawerRoom ? (
          <section className="game-room-drawer__body">
            <div className="game-room-drawer__header">
              <span className="game-room__number" aria-hidden="true">
                {drawerRoom.number}
              </span>
              <div>
                <small>房间上下文</small>
                <h2>{drawerRoom.title}</h2>
                <p>{drawerRoom.subtitle}</p>
              </div>
            </div>
            <div
              className={`game-room__scene${drawerRoomAsset ? ' has-room-asset' : ''} persona-${drawerRoom.scene.persona} device-${drawerRoom.scene.device}`}
              aria-hidden="true"
            >
              {drawerRoomAsset ? (
                <img
                  className="game-room__scene-asset"
                  src={drawerRoomAsset}
                  alt=""
                  loading="lazy"
                  decoding="async"
                />
              ) : null}
              <div className="game-room__wall-sign">
                <span />
                <span />
                <span />
              </div>
              <div className="game-room__device">
                <span />
                <span />
                <span />
              </div>
              <div className="game-room__prop game-room__prop--left" />
              <div className="game-room__prop game-room__prop--right" />
              <div className="game-room__npc">
                <span className="game-room__npc-head" />
                <span className="game-room__npc-body" />
                <span className="game-room__npc-shadow" />
              </div>
              <div className="game-room__meter">
                <span>{drawerRoom.scene.meterLabel}</span>
                <strong>{drawerRoom.scene.meterPercent}%</strong>
                <em style={{ width: `${drawerRoom.scene.meterPercent}%` }} />
              </div>
            </div>
            <p className="game-room-drawer__summary">{drawerRoom.summary}</p>
            <div className="game-room__badges">
              {drawerRoom.badges.map((badge) => (
                <Badge key={`drawer-${drawerRoom.id}-${badge.label}`} tone={badge.tone ?? 'neutral'}>
                  {badge.label}: {badge.value}
                </Badge>
              ))}
            </div>
            <ul className="game-room-drawer__details">
              {drawerRoom.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
            <div className="game-room-drawer__actions">
              <ButtonLink to={drawerRoom.href} variant="primary">
                {drawerRoom.primaryActionLabel}
              </ButtonLink>
              <button type="button" className="game-room__focus" onClick={() => setDrawerRoomId(null)}>
                关闭
              </button>
            </div>
          </section>
        ) : null}
      </Drawer>
    </main>
  );
}
