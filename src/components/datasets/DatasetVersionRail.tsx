import type { DatasetRecord, DatasetVersionRecord } from '../../../shared/domain';
import StateBlock from '../StateBlock';
import { Badge, StatusTag } from '../ui/Badge';
import { Button, ButtonLink } from '../ui/Button';
import { Card, Panel } from '../ui/Surface';
import { WorkspaceSectionHeader } from '../ui/WorkspacePage';
import { formatCompactTimestamp } from '../../utils/formatting';

type TranslateFn = (source: string, vars?: Record<string, string | number>) => string;
type QueueFilter = 'all' | 'needs_work' | 'in_review' | 'rejected' | 'approved';

interface DatasetVersionRailProps {
  t: TranslateFn;
  dataset: DatasetRecord;
  versions: DatasetVersionRecord[];
  selectedVersionId: string;
  selectedVersion: DatasetVersionRecord | null;
  selectedVersionLaunchReady: boolean;
  selectedVersionHasTrainSplit: boolean;
  selectedVersionHasCoverage: boolean;
  preferredReviewQueueForSelectedVersion: QueueFilter;
  busy: boolean;
  isRefreshing: boolean;
  onRefresh: () => void;
  onSelectVersion: (versionId: string) => void;
  formatCoveragePercent: (value: number) => string;
  buildTrainingPath: (versionId: string) => string;
  buildReviewPath: (versionId: string, queue: QueueFilter) => string;
  buildJobsPath: (versionId: string) => string;
  buildInferencePath: (versionId: string) => string;
}

const toSignedNumber = (value: number): string => (value > 0 ? `+${value}` : String(value));
const toSignedPercentPoints = (value: number): string => {
  const rounded = Math.round(value * 10) / 10;
  return rounded > 0 ? `+${rounded.toFixed(1)} pp` : `${rounded.toFixed(1)} pp`;
};
const resolveDeltaTone = (delta: number): 'success' | 'warning' | 'neutral' => {
  if (delta > 0) {
    return 'success';
  }
  if (delta < 0) {
    return 'warning';
  }
  return 'neutral';
};

export default function DatasetVersionRail({
  t,
  dataset,
  versions,
  selectedVersionId,
  selectedVersion,
  selectedVersionLaunchReady,
  selectedVersionHasTrainSplit,
  selectedVersionHasCoverage,
  preferredReviewQueueForSelectedVersion,
  busy,
  isRefreshing,
  onRefresh,
  onSelectVersion,
  formatCoveragePercent,
  buildTrainingPath,
  buildReviewPath,
  buildJobsPath,
  buildInferencePath
}: DatasetVersionRailProps) {
  const sortedVersions = [...versions].sort(
    (left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
  );
  const selectedVersionIndex = sortedVersions.findIndex((version) => version.id === selectedVersionId);
  const baselineVersion =
    selectedVersionIndex >= 0 && selectedVersionIndex < sortedVersions.length - 1
      ? sortedVersions[selectedVersionIndex + 1]
      : null;
  const selectedVersionComparison =
    selectedVersion && baselineVersion
      ? {
          itemCountDelta: selectedVersion.item_count - baselineVersion.item_count,
          coverageDelta: (selectedVersion.annotation_coverage - baselineVersion.annotation_coverage) * 100,
          trainDelta: selectedVersion.split_summary.train - baselineVersion.split_summary.train,
          valDelta: selectedVersion.split_summary.val - baselineVersion.split_summary.val,
          testDelta: selectedVersion.split_summary.test - baselineVersion.split_summary.test
        }
      : null;

  return (
    <>
      <Card as="section">
        <WorkspaceSectionHeader
          title={t('Version Operations')}
          description={t('Select one snapshot as the active version context for downstream actions.')}
        />
        {!selectedVersion ? (
          <StateBlock
            variant="empty"
            title={t('No active version')}
            description={t('Create or select a dataset version snapshot first.')}
          />
        ) : (
          <div className="stack">
            <Panel as="section" className="workspace-record-item compact stack tight" tone="soft">
              <div className="row between gap wrap align-center">
                <strong>{selectedVersion.version_name}</strong>
                <StatusTag status={selectedVersionLaunchReady ? 'ready' : 'draft'}>
                  {selectedVersionLaunchReady ? t('Ready') : t('draft')}
                </StatusTag>
              </div>
              <div className="row gap wrap">
                <Badge tone={dataset.status === 'ready' ? 'success' : 'warning'}>
                  {t('Dataset')}: {t(dataset.status)}
                </Badge>
                <Badge tone={selectedVersionHasTrainSplit ? 'success' : 'warning'}>
                  {t('train')}: {selectedVersion.split_summary.train}
                </Badge>
                <Badge tone={selectedVersionHasCoverage ? 'success' : 'warning'}>
                  {t('Coverage')}: {formatCoveragePercent(selectedVersion.annotation_coverage)}
                </Badge>
              </div>
              <small className="muted">
                {t('Version snapshot created at {time}', {
                  time: formatCompactTimestamp(selectedVersion.created_at, t('n/a'))
                })}
              </small>
              <div className="row gap wrap">
                <ButtonLink size="sm" variant="secondary" to={buildTrainingPath(selectedVersion.id)}>
                  {t('Train from this version')}
                </ButtonLink>
                <ButtonLink
                  size="sm"
                  variant="ghost"
                  to={buildReviewPath(selectedVersion.id, preferredReviewQueueForSelectedVersion)}
                >
                  {t('Open Review Queue')}
                </ButtonLink>
                <ButtonLink size="sm" variant="ghost" to={buildJobsPath(selectedVersion.id)}>
                  {t('Open version jobs')}
                </ButtonLink>
                <ButtonLink size="sm" variant="ghost" to={buildInferencePath(selectedVersion.id)}>
                  {t('Validate inference')}
                </ButtonLink>
              </div>
              {selectedVersionComparison && baselineVersion ? (
                <Panel as="section" className="stack tight" tone="soft">
                  <div className="row between gap wrap align-center">
                    <strong>{t('Cross-version Delta')}</strong>
                    <Badge tone="neutral">
                      {t('Baseline')}: {baselineVersion.version_name}
                    </Badge>
                  </div>
                  <div className="row gap wrap">
                    <Badge tone={resolveDeltaTone(selectedVersionComparison.itemCountDelta)}>
                      {t('Items')}: {toSignedNumber(selectedVersionComparison.itemCountDelta)}
                    </Badge>
                    <Badge tone={resolveDeltaTone(selectedVersionComparison.coverageDelta)}>
                      {t('Coverage')}: {toSignedPercentPoints(selectedVersionComparison.coverageDelta)}
                    </Badge>
                    <Badge tone={resolveDeltaTone(selectedVersionComparison.trainDelta)}>
                      {t('train')}: {toSignedNumber(selectedVersionComparison.trainDelta)}
                    </Badge>
                    <Badge tone={resolveDeltaTone(selectedVersionComparison.valDelta)}>
                      {t('val')}: {toSignedNumber(selectedVersionComparison.valDelta)}
                    </Badge>
                    <Badge tone={resolveDeltaTone(selectedVersionComparison.testDelta)}>
                      {t('test')}: {toSignedNumber(selectedVersionComparison.testDelta)}
                    </Badge>
                  </div>
                  <small className="muted">
                    {t('Delta compares the active snapshot against the previous version by creation time.')}
                  </small>
                </Panel>
              ) : (
                <small className="muted">
                  {t('Create at least two versions to unlock cross-version delta summary.')}
                </small>
              )}
            </Panel>
            {!selectedVersionLaunchReady ? (
              <small className="muted">
                {t(
                  'Launch readiness requires dataset ready status, train split > 0, and annotation coverage > 0.'
                )}
              </small>
            ) : null}
          </div>
        )}
      </Card>

      <Card as="section">
        <WorkspaceSectionHeader
          title={t('Dataset Versions')}
          actions={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onRefresh}
              disabled={busy || isRefreshing}
            >
              {isRefreshing ? t('Refreshing...') : t('Refresh')}
            </Button>
          }
        />
        {versions.length === 0 ? (
          <StateBlock variant="empty" title={t('No Versions')} description={t('Create first version snapshot after split.')} />
        ) : (
          <ul className="workspace-record-list compact">
            {versions.map((version) => (
              <Panel
                key={version.id}
                as="li"
                className={`workspace-record-item compact stack tight${selectedVersionId === version.id ? ' selected' : ''}`}
                tone="soft"
              >
                <div className="row between gap wrap align-center">
                  <strong>{version.version_name}</strong>
                  <div className="row gap wrap">
                    {selectedVersionId === version.id ? (
                      <Badge tone="success">{t('Active')}</Badge>
                    ) : null}
                    <Badge tone="neutral">{formatCompactTimestamp(version.created_at, t('n/a'))}</Badge>
                  </div>
                </div>
                <div className="row gap wrap">
                  <Badge tone="neutral">{t('Items')}: {version.item_count}</Badge>
                  <Badge tone="info">{t('Coverage')}: {formatCoveragePercent(version.annotation_coverage)}</Badge>
                  <Badge tone="neutral">
                    {t('train')} {version.split_summary.train} / {t('val')} {version.split_summary.val} / {t('test')}{' '}
                    {version.split_summary.test}
                  </Badge>
                </div>
                <small className="muted">
                  {t('Items {count} · Coverage {coverage}', {
                    count: version.item_count,
                    coverage: formatCoveragePercent(version.annotation_coverage)
                  })}
                </small>
                <div className="row gap wrap">
                  <Button
                    type="button"
                    size="sm"
                    variant={selectedVersionId === version.id ? 'secondary' : 'ghost'}
                    onClick={() => onSelectVersion(version.id)}
                  >
                    {selectedVersionId === version.id ? t('Active snapshot') : t('Set active snapshot')}
                  </Button>
                  <ButtonLink size="sm" variant="secondary" to={buildTrainingPath(version.id)}>
                    {t('Train from this version')}
                  </ButtonLink>
                  <ButtonLink
                    size="sm"
                    variant="ghost"
                    to={buildReviewPath(version.id, 'needs_work')}
                  >
                    {t('Open Review Queue')}
                  </ButtonLink>
                  <ButtonLink size="sm" variant="ghost" to={buildJobsPath(version.id)}>
                    {t('Open version jobs')}
                  </ButtonLink>
                </div>
              </Panel>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
