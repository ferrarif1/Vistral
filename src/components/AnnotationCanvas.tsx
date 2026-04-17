import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type MouseEvent
} from 'react';
import { Badge } from './ui/Badge';
import { useI18n } from '../i18n/I18nProvider';

export interface AnnotationBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
}

export type AnnotationCanvasToolMode = 'draw' | 'select';

interface AnnotationCanvasProps {
  title?: string;
  filename: string;
  imageUrl?: string | null;
  boxes: AnnotationBox[];
  predictionBoxes?: AnnotationBox[];
  defaultLabel: string;
  toolMode?: AnnotationCanvasToolMode;
  showPredictionOverlay?: boolean;
  onChange: (boxes: AnnotationBox[]) => void;
  onSelectionChange?: (box: AnnotationBox | null) => void;
  onBoxCreate?: (box: AnnotationBox) => void;
  onInteractionStart?: () => void;
  disabled?: boolean;
  width?: number;
  height?: number;
}

export interface AnnotationCanvasHandle {
  deleteSelectedBox: () => void;
  clearAllBoxes: () => void;
  getSelectedBox: () => AnnotationBox | null;
}

interface Point {
  x: number;
  y: number;
}

type ResizeHandle = 'nw' | 'ne' | 'sw' | 'se';

type InteractionState =
  | {
      type: 'drawing';
      start: Point;
      current: Point;
    }
  | {
      type: 'moving';
      boxId: string;
      startPoint: Point;
      startBox: AnnotationBox;
    }
  | {
      type: 'resizing';
      boxId: string;
      handle: ResizeHandle;
      startPoint: Point;
      startBox: AnnotationBox;
    };

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const normalizeRect = (start: Point, end: Point) => {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);

  return {
    x: left,
    y: top,
    width,
    height
  };
};

const nextBoxId = (): string => `box-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const MIN_BOX_SIZE = 8;

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName.toLowerCase();
  return tagName === 'input' || tagName === 'textarea' || tagName === 'select' || target.isContentEditable;
};

const cloneBox = (box: AnnotationBox): AnnotationBox => ({ ...box });

const toPredictionStyleBox = (box: AnnotationBox): AnnotationBox => ({
  ...box,
  label: box.label || '预测'
});

const renderBox = (
  box: AnnotationBox,
  className: string,
  extraProps?: { 'aria-hidden'?: boolean }
) => (
  <div
    key={box.id}
    className={className}
    style={{
      left: box.x,
      top: box.y,
      width: box.width,
      height: box.height
    }}
    {...extraProps}
  >
    <span>{box.label}</span>
  </div>
);

const AnnotationCanvas = forwardRef<AnnotationCanvasHandle, AnnotationCanvasProps>(function AnnotationCanvas(
  {
    filename,
    imageUrl = null,
    boxes,
    predictionBoxes = [],
    defaultLabel,
    toolMode = 'draw',
    showPredictionOverlay = false,
    onChange,
    onSelectionChange,
    onBoxCreate,
    onInteractionStart,
    disabled,
    width = 700,
    height = 420
  }: AnnotationCanvasProps,
  ref
) {
  const { t } = useI18n();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [interaction, setInteraction] = useState<InteractionState | null>(null);
  const [selectedBoxId, setSelectedBoxId] = useState<string | null>(null);
  const [imageLoadFailed, setImageLoadFailed] = useState(false);

  const selectedBox = useMemo(
    () => boxes.find((item) => item.id === selectedBoxId) ?? null,
    [boxes, selectedBoxId]
  );
  const showImage = Boolean(imageUrl) && !imageLoadFailed;
  const visiblePredictionBoxes = useMemo(
    () => predictionBoxes.map(toPredictionStyleBox),
    [predictionBoxes]
  );

  useEffect(() => {
    setImageLoadFailed(false);
  }, [imageUrl]);

  useEffect(() => {
    if (!selectedBoxId) {
      return;
    }

    if (!boxes.some((item) => item.id === selectedBoxId)) {
      setSelectedBoxId(null);
    }
  }, [boxes, selectedBoxId]);

  useEffect(() => {
    onSelectionChange?.(selectedBox ? cloneBox(selectedBox) : null);
  }, [onSelectionChange, selectedBox]);

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

  const commitBox = useCallback(
    (boxId: string, patch: Partial<AnnotationBox>) => {
      onChange(
        boxes.map((item) =>
          item.id === boxId
            ? {
                ...item,
                ...patch
              }
            : item
        )
      );
    },
    [boxes, onChange]
  );

  const updateMovingBox = (state: Extract<InteractionState, { type: 'moving' }>, point: Point) => {
    const dx = point.x - state.startPoint.x;
    const dy = point.y - state.startPoint.y;

    const x = clamp(state.startBox.x + dx, 0, width - state.startBox.width);
    const y = clamp(state.startBox.y + dy, 0, height - state.startBox.height);
    commitBox(state.boxId, {
      x: Number(x.toFixed(1)),
      y: Number(y.toFixed(1))
    });
  };

  const updateResizingBox = (
    state: Extract<InteractionState, { type: 'resizing' }>,
    point: Point
  ) => {
    const dx = point.x - state.startPoint.x;
    const dy = point.y - state.startPoint.y;
    const rightEdge = state.startBox.x + state.startBox.width;
    const bottomEdge = state.startBox.y + state.startBox.height;

    let nextX = state.startBox.x;
    let nextY = state.startBox.y;
    let nextWidth = state.startBox.width;
    let nextHeight = state.startBox.height;

    if (state.handle.includes('w')) {
      nextX = clamp(state.startBox.x + dx, 0, rightEdge - MIN_BOX_SIZE);
      nextWidth = rightEdge - nextX;
    }

    if (state.handle.includes('e')) {
      const nextRight = clamp(rightEdge + dx, state.startBox.x + MIN_BOX_SIZE, width);
      nextWidth = nextRight - state.startBox.x;
    }

    if (state.handle.includes('n')) {
      nextY = clamp(state.startBox.y + dy, 0, bottomEdge - MIN_BOX_SIZE);
      nextHeight = bottomEdge - nextY;
    }

    if (state.handle.includes('s')) {
      const nextBottom = clamp(bottomEdge + dy, state.startBox.y + MIN_BOX_SIZE, height);
      nextHeight = nextBottom - state.startBox.y;
    }

    commitBox(state.boxId, {
      x: Number(nextX.toFixed(1)),
      y: Number(nextY.toFixed(1)),
      width: Number(nextWidth.toFixed(1)),
      height: Number(nextHeight.toFixed(1))
    });
  };

  const beginStageInteraction = (event: MouseEvent<HTMLDivElement>) => {
    if (disabled) {
      return;
    }

    if (toolMode === 'select') {
      setSelectedBoxId(null);
      setInteraction(null);
      return;
    }

    const point = eventToPoint(event);
    if (!point) {
      return;
    }

    onInteractionStart?.();
    setSelectedBoxId(null);
    setInteraction({
      type: 'drawing',
      start: point,
      current: point
    });
  };

  const updateInteraction = (event: MouseEvent<HTMLDivElement>) => {
    if (!interaction || disabled) {
      return;
    }

    const point = eventToPoint(event);
    if (!point) {
      return;
    }

    if (interaction.type === 'drawing') {
      setInteraction({
        ...interaction,
        current: point
      });
      return;
    }

    if (interaction.type === 'moving') {
      updateMovingBox(interaction, point);
      return;
    }

    updateResizingBox(interaction, point);
  };

  const finishInteraction = () => {
    if (!interaction || disabled) {
      setInteraction(null);
      return;
    }

    if (interaction.type !== 'drawing') {
      setInteraction(null);
      return;
    }

    const draft = normalizeRect(interaction.start, interaction.current);
    setInteraction(null);

    if (draft.width < MIN_BOX_SIZE || draft.height < MIN_BOX_SIZE) {
      return;
    }

    const created: AnnotationBox = {
      id: nextBoxId(),
      x: Number(draft.x.toFixed(1)),
      y: Number(draft.y.toFixed(1)),
      width: Number(draft.width.toFixed(1)),
      height: Number(draft.height.toFixed(1)),
      label: defaultLabel.trim() || `region-${boxes.length + 1}`
    };

    onChange([...boxes, created]);
    setSelectedBoxId(created.id);
    onBoxCreate?.(cloneBox(created));
  };

  const removeSelected = useCallback(() => {
    if (!selectedBoxId) {
      return;
    }

    onChange(boxes.filter((item) => item.id !== selectedBoxId));
    setSelectedBoxId(null);
  }, [boxes, onChange, selectedBoxId]);

  const clearAll = useCallback(() => {
    onChange([]);
    setSelectedBoxId(null);
  }, [onChange]);

  useImperativeHandle(
    ref,
    () => ({
      deleteSelectedBox: removeSelected,
      clearAllBoxes: clearAll,
      getSelectedBox: () => (selectedBox ? cloneBox(selectedBox) : null)
    }),
    [clearAll, removeSelected, selectedBox]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (disabled || isEditableTarget(event.target)) {
        return;
      }

      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedBoxId) {
        event.preventDefault();
        removeSelected();
        return;
      }

      if (event.key === 'Escape') {
        if (interaction?.type === 'drawing') {
          event.preventDefault();
          setInteraction(null);
          return;
        }

        if (selectedBoxId) {
          event.preventDefault();
          setSelectedBoxId(null);
        }
        return;
      }

      if (!selectedBoxId || !event.shiftKey) {
        return;
      }

      const current = boxes.find((item) => item.id === selectedBoxId);
      if (!current) {
        return;
      }

      const step = 8;
      switch (event.key) {
        case 'ArrowUp':
          event.preventDefault();
          commitBox(current.id, {
            y: Number(clamp(current.y - step, 0, height - current.height).toFixed(1))
          });
          break;
        case 'ArrowDown':
          event.preventDefault();
          commitBox(current.id, {
            y: Number(clamp(current.y + step, 0, height - current.height).toFixed(1))
          });
          break;
        case 'ArrowLeft':
          event.preventDefault();
          commitBox(current.id, {
            x: Number(clamp(current.x - step, 0, width - current.width).toFixed(1))
          });
          break;
        case 'ArrowRight':
          event.preventDefault();
          commitBox(current.id, {
            x: Number(clamp(current.x + step, 0, width - current.width).toFixed(1))
          });
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [boxes, commitBox, disabled, height, interaction?.type, removeSelected, selectedBoxId, width]);

  const previewRect =
    interaction?.type === 'drawing' ? normalizeRect(interaction.start, interaction.current) : null;

  return (
    <div className="annotation-canvas-surface">
      <div
        ref={stageRef}
        className={`annotation-canvas-stage annotation-canvas-stage--${toolMode}`}
        style={{ width, height }}
        onMouseDown={beginStageInteraction}
        onMouseMove={updateInteraction}
        onMouseUp={finishInteraction}
        onMouseLeave={finishInteraction}
      >
        {showImage ? (
          <img
            src={imageUrl ?? undefined}
            alt={filename}
            className="annotation-canvas-image"
            onError={() => setImageLoadFailed(true)}
          />
        ) : null}

        <div className={`annotation-canvas-bg${showImage ? ' hidden' : ''}`}>
          <strong>{filename}</strong>
        </div>

        {showPredictionOverlay
          ? visiblePredictionBoxes.map((box) =>
              renderBox(box, 'annotation-canvas-box prediction', {
                'aria-hidden': true
              })
            )
          : null}

        {boxes.map((box) => (
          <div
            key={box.id}
            className={`annotation-canvas-box${selectedBoxId === box.id ? ' selected' : ''}`}
            style={{
              left: box.x,
              top: box.y,
              width: box.width,
              height: box.height
            }}
            onMouseDown={(event) => {
              if (disabled) {
                return;
              }

              event.stopPropagation();
              const point = eventToPoint(event);
              if (!point) {
                return;
              }

              onInteractionStart?.();
              setSelectedBoxId(box.id);
              setInteraction({
                type: 'moving',
                boxId: box.id,
                startPoint: point,
                startBox: box
              });
            }}
          >
            <span>{box.label}</span>
            {selectedBoxId === box.id
              ? (['nw', 'ne', 'sw', 'se'] as ResizeHandle[]).map((handle) => (
                  <button
                    key={handle}
                    type="button"
                    className={`annotation-canvas-handle ${handle}`}
                    onMouseDown={(event) => {
                      if (disabled) {
                        return;
                      }

                      event.stopPropagation();
                      const point = pointFromClient(event.clientX, event.clientY);
                      if (!point) {
                        return;
                      }

                      onInteractionStart?.();
                      setInteraction({
                        type: 'resizing',
                        boxId: box.id,
                        handle,
                        startPoint: point,
                        startBox: box
                      });
                    }}
                    aria-label={t('Adjust selected box')}
                  />
                ))
              : null}
          </div>
        ))}

        {previewRect ? (
          <div
            className="annotation-canvas-box preview"
            style={{
              left: previewRect.x,
              top: previewRect.y,
              width: previewRect.width,
              height: previewRect.height
            }}
          />
        ) : null}
      </div>

      <div className="annotation-canvas-status">
        <small className="muted">
          {toolMode === 'draw'
            ? t('Draw mode: drag to create a box. Click a box to edit.')
            : t('Select mode: click a box to edit. Press B to draw.')}
        </small>
        <div className="row gap wrap align-center">
          <Badge tone={toolMode === 'draw' ? 'info' : 'neutral'}>
            {toolMode === 'draw' ? t('Draw') : t('Select')}
          </Badge>
          {showPredictionOverlay && visiblePredictionBoxes.length > 0 ? (
            <Badge tone="neutral">{t('Prediction')}: {visiblePredictionBoxes.length}</Badge>
          ) : null}
          {selectedBox ? (
            <Badge tone="neutral">{t('Selected')}: {selectedBox.label}</Badge>
          ) : (
            <Badge tone="neutral">{t('No selection')}</Badge>
          )}
          {selectedBox ? <Badge tone="neutral">{t('Shift + arrow keys to nudge')}</Badge> : null}
        </div>
      </div>
    </div>
  );
});

export default AnnotationCanvas;
