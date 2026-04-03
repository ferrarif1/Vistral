import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useI18n } from '../i18n/I18nProvider';

export interface AnnotationBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
}

interface AnnotationCanvasProps {
  title: string;
  filename: string;
  boxes: AnnotationBox[];
  onChange: (boxes: AnnotationBox[]) => void;
  disabled?: boolean;
  width?: number;
  height?: number;
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

export default function AnnotationCanvas({
  title,
  filename,
  boxes,
  onChange,
  disabled,
  width = 700,
  height = 380
}: AnnotationCanvasProps) {
  const { t } = useI18n();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [interaction, setInteraction] = useState<InteractionState | null>(null);
  const [selectedBoxId, setSelectedBoxId] = useState<string | null>(null);

  const selectedBox = useMemo(
    () => boxes.find((item) => item.id === selectedBoxId) ?? null,
    [boxes, selectedBoxId]
  );

  const eventToPoint = (event: MouseEvent<HTMLDivElement>): Point | null => {
    return pointFromClient(event.clientX, event.clientY);
  };

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

  const beginDraw = (event: MouseEvent<HTMLDivElement>) => {
    if (disabled) {
      return;
    }

    const point = eventToPoint(event);
    if (!point) {
      return;
    }

    setSelectedBoxId(null);
    setInteraction({
      type: 'drawing',
      start: point,
      current: point
    });
  };

  const moveDraw = (event: MouseEvent<HTMLDivElement>) => {
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

  const finishDraw = () => {
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
      label: `region-${boxes.length + 1}`
    };

    onChange([...boxes, created]);
    setSelectedBoxId(created.id);
  };

  const removeSelected = () => {
    if (!selectedBoxId) {
      return;
    }

    onChange(boxes.filter((item) => item.id !== selectedBoxId));
    setSelectedBoxId(null);
  };

  const clearAll = () => {
    onChange([]);
    setSelectedBoxId(null);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (disabled || !selectedBoxId) {
        return;
      }

      const current = boxes.find((item) => item.id === selectedBoxId);
      if (!current) {
        return;
      }

      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      const isEditable =
        target?.isContentEditable || tagName === 'input' || tagName === 'textarea' || tagName === 'select';

      if (isEditable) {
        return;
      }

      const step = event.shiftKey ? 10 : 1;
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
        case 'Delete':
        case 'Backspace':
          event.preventDefault();
          onChange(boxes.filter((item) => item.id !== selectedBoxId));
          setSelectedBoxId(null);
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [boxes, commitBox, disabled, height, onChange, selectedBoxId, width]);

  const updateSelected = (patch: Partial<AnnotationBox>) => {
    if (!selectedBoxId) {
      return;
    }

    onChange(
      boxes.map((item) =>
        item.id === selectedBoxId
          ? {
              ...item,
              ...patch
            }
          : item
      )
    );
  };

  const previewRect =
    interaction?.type === 'drawing' ? normalizeRect(interaction.start, interaction.current) : null;

  return (
    <section className="card stack">
      <div className="row between gap align-center">
        <h3>{t(title)}</h3>
        <span className="muted">{t('Drag to create box. Click box to edit.')}</span>
      </div>

      <div
        ref={stageRef}
        className="annotation-canvas-stage"
        style={{ width, height }}
        onMouseDown={beginDraw}
        onMouseMove={moveDraw}
        onMouseUp={finishDraw}
        onMouseLeave={finishDraw}
      >
        <div className="annotation-canvas-bg">
          <strong>{filename}</strong>
        </div>

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
            {selectedBoxId === box.id ? (
              <>
                {(['nw', 'ne', 'sw', 'se'] as ResizeHandle[]).map((handle) => (
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

                      setInteraction({
                        type: 'resizing',
                        boxId: box.id,
                        handle,
                        startPoint: point,
                        startBox: box
                      });
                    }}
                    disabled={disabled}
                  />
                ))}
              </>
            ) : null}
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

      <div className="row gap wrap">
        <button onClick={removeSelected} disabled={disabled || !selectedBoxId}>
          {t('Delete Selected Box')}
        </button>
        <button onClick={clearAll} disabled={disabled || boxes.length === 0}>
          {t('Clear All Boxes')}
        </button>
      </div>

      {selectedBox ? (
        <div className="annotation-box-editor">
          <label>
            {t('Label')}
            <input
              value={selectedBox.label}
              onChange={(event) => updateSelected({ label: event.target.value })}
              disabled={disabled}
            />
          </label>
          <label>
            X
            <input
              value={selectedBox.x}
              onChange={(event) => updateSelected({ x: Number(event.target.value) || 0 })}
              disabled={disabled}
            />
          </label>
          <label>
            Y
            <input
              value={selectedBox.y}
              onChange={(event) => updateSelected({ y: Number(event.target.value) || 0 })}
              disabled={disabled}
            />
          </label>
          <label>
            {t('Width')}
            <input
              value={selectedBox.width}
              onChange={(event) => updateSelected({ width: Number(event.target.value) || 0 })}
              disabled={disabled}
            />
          </label>
          <label>
            {t('Height')}
            <input
              value={selectedBox.height}
              onChange={(event) => updateSelected({ height: Number(event.target.value) || 0 })}
              disabled={disabled}
            />
          </label>
        </div>
      ) : (
        <small className="muted">{t('No box selected.')}</small>
      )}
    </section>
  );
}
