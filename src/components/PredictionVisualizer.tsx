import type { UnifiedInferenceOutput } from '../../shared/domain';
import { useI18n } from '../i18n/I18nProvider';
import StateBlock from './StateBlock';

interface PredictionVisualizerProps {
  output: UnifiedInferenceOutput | null;
  title?: string;
}

const STAGE_WIDTH = 700;
const STAGE_HEIGHT = 380;

const scalePoint = (
  x: number,
  y: number,
  imageWidth: number,
  imageHeight: number
): { x: number; y: number } => ({
  x: (x / Math.max(imageWidth, 1)) * STAGE_WIDTH,
  y: (y / Math.max(imageHeight, 1)) * STAGE_HEIGHT
});

export default function PredictionVisualizer({ output, title = 'Prediction Visualization' }: PredictionVisualizerProps) {
  const { t } = useI18n();
  const finalTitle = t(title);

  if (!output) {
    return (
      <section className="card stack">
        <h3>{finalTitle}</h3>
        <StateBlock
          variant="empty"
          title={t('No Output')}
          description={t('Run inference to visualize results.')}
        />
      </section>
    );
  }

  const imageWidth = output.image.width || 1;
  const imageHeight = output.image.height || 1;

  return (
    <section className="card stack">
      <h3>{finalTitle}</h3>
      <small className="muted">
        {output.image.filename} · {output.task_type} · {output.framework}
      </small>

      <div className="prediction-stage" style={{ width: STAGE_WIDTH, height: STAGE_HEIGHT }}>
        <div className="prediction-stage-bg">
          <strong>{output.image.filename}</strong>
        </div>

        {output.boxes.map((box, index) => {
          const topLeft = scalePoint(box.x, box.y, imageWidth, imageHeight);
          const scaledWidth = (box.width / imageWidth) * STAGE_WIDTH;
          const scaledHeight = (box.height / imageHeight) * STAGE_HEIGHT;

          return (
            <div
              key={`${box.label}-${index}`}
              className="prediction-box"
              style={{ left: topLeft.x, top: topLeft.y, width: scaledWidth, height: scaledHeight }}
            >
              <span>
                {box.label} {box.score.toFixed(2)}
              </span>
            </div>
          );
        })}

        {output.rotated_boxes.map((box, index) => {
          const topLeft = scalePoint(box.cx - box.width / 2, box.cy - box.height / 2, imageWidth, imageHeight);
          const scaledWidth = (box.width / imageWidth) * STAGE_WIDTH;
          const scaledHeight = (box.height / imageHeight) * STAGE_HEIGHT;

          return (
            <div
              key={`${box.label}-${index}`}
              className="prediction-box rotated"
              style={{
                left: topLeft.x,
                top: topLeft.y,
                width: scaledWidth,
                height: scaledHeight,
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
          <svg className="prediction-svg" viewBox={`0 0 ${STAGE_WIDTH} ${STAGE_HEIGHT}`}>
            {output.polygons.map((polygon, index) => {
              const points = polygon.points
                .map((point) => scalePoint(point.x, point.y, imageWidth, imageHeight))
                .map((point) => `${point.x},${point.y}`)
                .join(' ');

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
        <article className="card stack tight">
          <strong>{t('Boxes')}</strong>
          <small className="muted">{output.boxes.length}</small>
        </article>
        <article className="card stack tight">
          <strong>{t('Rotated Boxes')}</strong>
          <small className="muted">{output.rotated_boxes.length}</small>
        </article>
        <article className="card stack tight">
          <strong>{t('Polygons')}</strong>
          <small className="muted">{output.polygons.length}</small>
        </article>
        <article className="card stack tight">
          <strong>{t('OCR Lines')}</strong>
          <small className="muted">{output.ocr.lines.length}</small>
        </article>
      </section>

      {output.ocr.lines.length > 0 ? (
        <section className="card stack">
          <h4>{t('OCR Lines')}</h4>
          <ul className="list">
            {output.ocr.lines.map((line, index) => (
              <li key={`${line.text}-${index}`} className="list-item row between gap">
                <span>{line.text}</span>
                <span className="chip">{line.confidence.toFixed(2)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
