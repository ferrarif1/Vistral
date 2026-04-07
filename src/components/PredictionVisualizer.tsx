import { useEffect, useState } from 'react';
import type { UnifiedInferenceOutput } from '../../shared/domain';
import { useI18n } from '../i18n/I18nProvider';
import StateBlock from './StateBlock';
import { Badge } from './ui/Badge';
import { Card, Panel } from './ui/Surface';

interface PredictionVisualizerProps {
  output: UnifiedInferenceOutput | null;
  title?: string;
  imageUrl?: string | null;
}

const toPercent = (value: number, total: number): string =>
  `${(value / Math.max(total, 1)) * 100}%`;

export default function PredictionVisualizer({
  output,
  title = 'Prediction Visualization',
  imageUrl = null
}: PredictionVisualizerProps) {
  const { t } = useI18n();
  const finalTitle = t(title);
  const [imageLoadFailed, setImageLoadFailed] = useState(false);

  useEffect(() => {
    setImageLoadFailed(false);
  }, [imageUrl]);

  if (!output) {
    return (
      <Card as="section" className="stack">
        <h3>{finalTitle}</h3>
        <StateBlock
          variant="empty"
          title={t('No Output')}
          description={t('Run inference to visualize results.')}
        />
      </Card>
    );
  }

  const imageWidth = output.image.width || 1;
  const imageHeight = output.image.height || 1;
  const showImage = Boolean(imageUrl) && !imageLoadFailed;
  const stageAspectRatio = `${Math.max(imageWidth, 1)} / ${Math.max(imageHeight, 1)}`;

  return (
    <Card as="section" className="stack">
      <h3>{finalTitle}</h3>
      <small className="muted">
        {output.image.filename} · {output.task_type} · {output.framework}
      </small>

      <div className="prediction-stage" style={{ aspectRatio: stageAspectRatio }}>
        {showImage ? (
          <img
            src={imageUrl ?? undefined}
            alt={output.image.filename}
            className="prediction-stage-image"
            onError={() => setImageLoadFailed(true)}
          />
        ) : null}

        <div className={`prediction-stage-bg${showImage ? ' hidden' : ''}`}>
          <strong>{output.image.filename}</strong>
        </div>

        {output.boxes.map((box, index) => {
          return (
            <div
              key={`${box.label}-${index}`}
              className="prediction-box"
              style={{
                left: toPercent(box.x, imageWidth),
                top: toPercent(box.y, imageHeight),
                width: toPercent(box.width, imageWidth),
                height: toPercent(box.height, imageHeight)
              }}
            >
              <span>
                {box.label} {box.score.toFixed(2)}
              </span>
            </div>
          );
        })}

        {output.rotated_boxes.map((box, index) => {
          return (
            <div
              key={`${box.label}-${index}`}
              className="prediction-box rotated"
              style={{
                left: toPercent(box.cx - box.width / 2, imageWidth),
                top: toPercent(box.cy - box.height / 2, imageHeight),
                width: toPercent(box.width, imageWidth),
                height: toPercent(box.height, imageHeight),
                transform: `rotate(${box.angle}deg)`
              }}
            >
              <span>
                {box.label} {box.score.toFixed(2)}
              </span>
            </div>
          );
        })}

        {output.polygons.length > 0 ? (
          <svg className="prediction-svg" viewBox={`0 0 ${imageWidth} ${imageHeight}`} preserveAspectRatio="none">
            {output.polygons.map((polygon, index) => {
              const points = polygon.points.map((point) => `${point.x},${point.y}`).join(' ');

              return (
                <polygon
                  key={`${polygon.label}-${index}`}
                  points={points}
                  className="prediction-polygon"
                />
              );
            })}
          </svg>
        ) : null}
      </div>

      <section className="prediction-summary-grid">
        <Card as="article" className="stack tight">
          <strong>{t('Boxes')}</strong>
          <small className="muted">{output.boxes.length}</small>
        </Card>
        <Card as="article" className="stack tight">
          <strong>{t('Rotated Boxes')}</strong>
          <small className="muted">{output.rotated_boxes.length}</small>
        </Card>
        <Card as="article" className="stack tight">
          <strong>{t('Polygons')}</strong>
          <small className="muted">{output.polygons.length}</small>
        </Card>
        <Card as="article" className="stack tight">
          <strong>{t('OCR Lines')}</strong>
          <small className="muted">{output.ocr.lines.length}</small>
        </Card>
      </section>

      {output.ocr.lines.length > 0 ? (
        <Card as="section" className="stack">
          <h4>{t('OCR Lines')}</h4>
          <ul className="workspace-record-list compact">
            {output.ocr.lines.map((line, index) => (
              <Panel key={`${line.text}-${index}`} as="li" className="workspace-record-item compact row between gap wrap" tone="soft">
                <span>{line.text}</span>
                <Badge tone="info">{line.confidence.toFixed(2)}</Badge>
              </Panel>
            ))}
          </ul>
        </Card>
      ) : null}
    </Card>
  );
}
