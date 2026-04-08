import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import StateBlock from './StateBlock';
import { Button } from './ui/Button';
import { Input } from './ui/Field';
import { Card } from './ui/Surface';

export interface PolygonAnnotation {
  id: string;
  label: string;
  points: Array<{ x: number; y: number }>;
}

interface PolygonCanvasProps {
  title: string;
  filename: string;
  imageUrl?: string | null;
  polygons: PolygonAnnotation[];
  onChange: (polygons: PolygonAnnotation[]) => void;
  disabled?: boolean;
  width?: number;
  height?: number;
}

interface Point {
  x: number;
  y: number;
}

interface DragTarget {
  polygonId: string;
  pointIndex: number;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const nextPolygonId = (): string => `poly-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

export default function PolygonCanvas({
  title,
  filename,
  imageUrl = null,
  polygons,
  onChange,
  disabled,
  width = 700,
  height = 380
}: PolygonCanvasProps) {
  const { t } = useI18n();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [draftPoints, setDraftPoints] = useState<Point[]>([]);
  const [selectedPolygonId, setSelectedPolygonId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState('region');
  const [dragTarget, setDragTarget] = useState<DragTarget | null>(null);
  const [error, setError] = useState('');
  const [imageLoadFailed, setImageLoadFailed] = useState(false);

  const selectedPolygon = useMemo(
    () => polygons.find((polygon) => polygon.id === selectedPolygonId) ?? null,
    [polygons, selectedPolygonId]
  );
  const showImage = Boolean(imageUrl) && !imageLoadFailed;

  useEffect(() => {
    setImageLoadFailed(false);
  }, [imageUrl]);

  useEffect(() => {
    if (!selectedPolygonId) {
      return;
    }

    if (!polygons.some((polygon) => polygon.id === selectedPolygonId)) {
      setSelectedPolygonId(null);
    }
  }, [polygons, selectedPolygonId]);

  const pointFromClient = (clientX: number, clientY: number): Point | null => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) {
      return null;
    }

    return {
      x: clamp(clientX - rect.left, 0, rect.width),
      y: clamp(clientY - rect.top, 0, rect.height)
    };
  };

  const eventToPoint = (event: MouseEvent<HTMLDivElement>): Point | null =>
    pointFromClient(event.clientX, event.clientY);

  const updateSelectedPolygon = (patch: Partial<PolygonAnnotation>) => {
    if (!selectedPolygonId) {
      return;
    }

    onChange(
      polygons.map((polygon) =>
        polygon.id === selectedPolygonId
          ? {
              ...polygon,
              ...patch
            }
          : polygon
      )
    );
  };

  const clearDraft = useCallback(() => {
    setDraftPoints([]);
    setError('');
  }, []);

  const removeSelected = useCallback(() => {
    if (!selectedPolygonId) {
      return;
    }

    onChange(polygons.filter((polygon) => polygon.id !== selectedPolygonId));
    setSelectedPolygonId(null);
  }, [onChange, polygons, selectedPolygonId]);

  const addDraftPoint = (event: MouseEvent<HTMLDivElement>) => {
    if (disabled || dragTarget) {
      return;
    }

    const target = event.target as Element | null;
    if (
      target?.closest('.polygon-canvas-shape, .polygon-canvas-handle, .polygon-canvas-draft-point')
    ) {
      return;
    }

    const point = eventToPoint(event);
    if (!point) {
      return;
    }

    setDraftPoints((prev) => [...prev, point]);
    setError('');
  };

  const completePolygon = () => {
    if (draftPoints.length < 3) {
      setError(t('Polygon requires at least 3 points.'));
      return;
    }

    const created: PolygonAnnotation = {
      id: nextPolygonId(),
      label: draftLabel.trim() || `polygon-${polygons.length + 1}`,
      points: draftPoints.map((point) => ({
        x: Number(point.x.toFixed(1)),
        y: Number(point.y.toFixed(1))
      }))
    };

    onChange([...polygons, created]);
    setDraftPoints([]);
    setSelectedPolygonId(created.id);
    setError('');
  };

  const clearAll = () => {
    onChange([]);
    setSelectedPolygonId(null);
    setDraftPoints([]);
  };

  const onDragMove = (event: MouseEvent<HTMLDivElement>) => {
    if (!dragTarget || disabled) {
      return;
    }

    const point = eventToPoint(event);
    if (!point) {
      return;
    }

    onChange(
      polygons.map((polygon) => {
        if (polygon.id !== dragTarget.polygonId) {
          return polygon;
        }

        return {
          ...polygon,
          points: polygon.points.map((current, index) =>
            index === dragTarget.pointIndex
              ? {
                  x: Number(point.x.toFixed(1)),
                  y: Number(point.y.toFixed(1))
                }
              : current
          )
        };
      })
    );
  };

  const stopDrag = () => {
    if (dragTarget) {
      setDragTarget(null);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (disabled) {
        return;
      }

      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      const isEditable =
        target?.isContentEditable || tagName === 'input' || tagName === 'textarea' || tagName === 'select';
      if (isEditable) {
        return;
      }

      if (event.key === 'Escape' && draftPoints.length > 0) {
        event.preventDefault();
        clearDraft();
        return;
      }

      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedPolygonId) {
        event.preventDefault();
        removeSelected();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [clearDraft, disabled, draftPoints.length, removeSelected, selectedPolygonId]);

  const draftPolylinePoints = draftPoints.map((point) => `${point.x},${point.y}`).join(' ');

  return (
    <Card as="section">
      <div className="row between gap align-center">
        <h3>{t(title)}</h3>
        <span className="muted">{t('Click to add points, then complete polygon. Drag vertices to adjust.')}</span>
      </div>

      <div
        ref={stageRef}
        className="polygon-canvas-stage"
        style={{ width, height }}
        onClick={addDraftPoint}
        onMouseMove={onDragMove}
        onMouseUp={stopDrag}
        onMouseLeave={stopDrag}
      >
        {showImage ? (
          <img
            src={imageUrl ?? undefined}
            alt={filename}
            className="polygon-canvas-image"
            onError={() => setImageLoadFailed(true)}
          />
        ) : null}

        <div className={`polygon-canvas-bg${showImage ? ' hidden' : ''}`}>
          <strong>{filename}</strong>
        </div>

        <svg className="polygon-canvas-svg" viewBox={`0 0 ${width} ${height}`}>
          {polygons.map((polygon) => {
            const points = polygon.points.map((point) => `${point.x},${point.y}`).join(' ');
            return (
              <g key={polygon.id}>
                <polygon
                  className={`polygon-canvas-shape${selectedPolygonId === polygon.id ? ' selected' : ''}`}
                  points={points}
                  onMouseDown={(event) => {
                    event.stopPropagation();
                    setSelectedPolygonId(polygon.id);
                  }}
                  onClick={(event) => event.stopPropagation()}
                />

                {selectedPolygonId === polygon.id
                  ? polygon.points.map((point, index) => (
                      <circle
                        key={`${polygon.id}-${index}`}
                        className="polygon-canvas-handle"
                        cx={point.x}
                        cy={point.y}
                        r={6}
                        onMouseDown={(event) => {
                          if (disabled) {
                            return;
                          }

                          event.stopPropagation();
                          setDragTarget({
                            polygonId: polygon.id,
                            pointIndex: index
                          });
                        }}
                        onClick={(event) => event.stopPropagation()}
                      />
                    ))
                  : null}
              </g>
            );
          })}

          {draftPoints.length > 0 ? (
            <polyline className="polygon-canvas-draft" points={draftPolylinePoints} />
          ) : null}

          {draftPoints.map((point, index) => (
            <circle key={`draft-${index}`} className="polygon-canvas-draft-point" cx={point.x} cy={point.y} r={4} />
          ))}
        </svg>
      </div>

      <div className="row gap wrap">
        <Button onClick={completePolygon} variant="secondary" size="sm" disabled={disabled || draftPoints.length < 3}>
          {t('Complete Polygon')}
        </Button>
        <Button onClick={clearDraft} variant="ghost" size="sm" disabled={disabled || draftPoints.length === 0}>
          {t('Clear Draft Points')}
        </Button>
        <Button onClick={removeSelected} variant="secondary" size="sm" disabled={disabled || !selectedPolygonId}>
          {t('Delete Selected Polygon')}
        </Button>
        <Button onClick={clearAll} variant="ghost" size="sm" disabled={disabled || polygons.length === 0}>
          {t('Clear All Polygons')}
        </Button>
      </div>

      <div className="polygon-meta-grid">
        <label>
          {t('New Polygon Label')}
          <Input value={draftLabel} onChange={(event) => setDraftLabel(event.target.value)} disabled={disabled} />
        </label>

        <label>
          {t('Selected Polygon Label')}
          <Input
            value={selectedPolygon?.label ?? ''}
            onChange={(event) => updateSelectedPolygon({ label: event.target.value })}
            disabled={disabled || !selectedPolygon}
            placeholder={t('Select polygon to edit label')}
          />
        </label>
      </div>

      {error ? <StateBlock variant="error" title={t('Polygon Error')} description={error} /> : null}
    </Card>
  );
}
