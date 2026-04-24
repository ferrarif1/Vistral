import { useMemo, useState } from 'react';
import type { TrainingCockpitMetricPoint } from './types';

const chartWidth = 720;
const chartHeight = 260;
const padding = { top: 20, right: 18, bottom: 34, left: 44 };

export interface CockpitLineChartSeries {
  key: string;
  label: string;
  color: string;
  valueAccessor: (point: TrainingCockpitMetricPoint) => number | null;
}

interface CockpitLineChartProps {
  title: string;
  description: string;
  points: TrainingCockpitMetricPoint[];
  series: CockpitLineChartSeries[];
  emptyTitle: string;
  emptyDescription: string;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export default function CockpitLineChart({
  title,
  description,
  points,
  series,
  emptyTitle,
  emptyDescription
}: CockpitLineChartProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const chart = useMemo(() => {
    const visibleSeries = series.filter((item) => points.some((point) => item.valueAccessor(point) !== null));
    if (visibleSeries.length === 0 || points.length === 0) {
      return null;
    }

    const values = visibleSeries.flatMap((item) =>
      points
        .map((point) => item.valueAccessor(point))
        .filter((value): value is number => value !== null)
    );
    if (values.length === 0) {
      return null;
    }

    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const innerWidth = chartWidth - padding.left - padding.right;
    const innerHeight = chartHeight - padding.top - padding.bottom;
    const stepWidth = points.length <= 1 ? innerWidth : innerWidth / (points.length - 1);
    const scaleX = (index: number) => padding.left + stepWidth * index;
    const scaleY = (value: number) =>
      padding.top + innerHeight - ((value - min) / range) * innerHeight;

    return {
      innerWidth,
      innerHeight,
      min,
      max,
      visibleSeries,
      lines: visibleSeries.map((item) => ({
        ...item,
        polyline: points
          .map((point, index) => {
            const value = item.valueAccessor(point);
            if (value === null) {
              return null;
            }
            return `${scaleX(index)},${scaleY(value)}`;
          })
          .filter((entry): entry is string => Boolean(entry))
          .join(' '),
        markers: points.map((point, index) => {
          const value = item.valueAccessor(point);
          return value === null
            ? null
            : {
                x: scaleX(index),
                y: scaleY(value),
                value
              };
        })
      })),
      overlays: points.map((point, index) => ({
        x: clamp(scaleX(index) - stepWidth / 2, padding.left, chartWidth - padding.right),
        width: points.length <= 1 ? innerWidth : Math.max(18, stepWidth),
        step: point.step
      })),
      scaleX,
      scaleY
    };
  }, [points, series]);

  const hoveredPoint =
    chart && activeIndex !== null && activeIndex >= 0 && activeIndex < points.length ? points[activeIndex] : null;

  if (!chart) {
    return (
      <div className="training-cockpit-panel stack tight">
        <div className="training-cockpit-panel__header">
          <div className="stack tight">
            <h3>{title}</h3>
            <small className="muted">{description}</small>
          </div>
        </div>
        <div className="training-cockpit-chart-empty stack tight">
          <strong>{emptyTitle}</strong>
          <small className="muted">{emptyDescription}</small>
        </div>
      </div>
    );
  }

  return (
    <div className="training-cockpit-panel stack tight">
      <div className="training-cockpit-panel__header">
        <div className="stack tight">
          <h3>{title}</h3>
          <small className="muted">{description}</small>
        </div>
        {hoveredPoint ? (
          <div className="training-cockpit-chart-tooltip">
            <strong>
              Epoch {hoveredPoint.epoch} · Step {hoveredPoint.step}
            </strong>
            <small className="muted">{new Date(hoveredPoint.recordedAt).toLocaleTimeString()}</small>
          </div>
        ) : (
          <small className="muted">Hover to inspect exact values.</small>
        )}
      </div>

      <div className="training-cockpit-chart-shell">
        <svg
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          className="training-cockpit-chart"
          role="img"
          aria-label={`${title} chart`}
          onMouseLeave={() => setActiveIndex(null)}
        >
          {Array.from({ length: 4 }, (_, index) => {
            const ratio = index / 3;
            const y = padding.top + chart.innerHeight * ratio;
            return (
              <g key={`grid-${index}`}>
                <line
                  x1={padding.left}
                  y1={y}
                  x2={chartWidth - padding.right}
                  y2={y}
                  stroke="rgba(255,255,255,0.08)"
                  strokeWidth="1"
                />
                <text
                  x={8}
                  y={y + 4}
                  fill="rgba(224,232,255,0.64)"
                  fontSize="12"
                >
                  {(chart.max - ((chart.max - chart.min) * index) / 3).toFixed(2)}
                </text>
              </g>
            );
          })}

          {chart.lines.map((item) => (
            <g key={item.key}>
              <polyline
                points={item.polyline}
                fill="none"
                stroke={item.color}
                strokeWidth="2.8"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {item.markers.map((marker, index) =>
                marker ? (
                  <circle
                    key={`${item.key}-${index}`}
                    cx={marker.x}
                    cy={marker.y}
                    r={activeIndex === index ? 5 : 3}
                    fill={item.color}
                    opacity={activeIndex === null || activeIndex === index ? 1 : 0.5}
                  />
                ) : null
              )}
            </g>
          ))}

          {chart.overlays.map((overlay, index) => (
            <rect
              key={`overlay-${overlay.step}`}
              x={overlay.x}
              y={padding.top}
              width={overlay.width}
              height={chart.innerHeight}
              fill="transparent"
              onMouseEnter={() => setActiveIndex(index)}
            />
          ))}

          {activeIndex !== null && chart.overlays[activeIndex] ? (
            <line
              x1={chart.scaleX(activeIndex)}
              y1={padding.top}
              x2={chart.scaleX(activeIndex)}
              y2={chartHeight - padding.bottom}
              stroke="rgba(132, 198, 255, 0.24)"
              strokeWidth="1"
              strokeDasharray="4 4"
            />
          ) : null}
        </svg>
      </div>

      <div className="training-cockpit-chart-legend">
        {chart.visibleSeries.map((item) => {
          const value = hoveredPoint ? item.valueAccessor(hoveredPoint) : item.valueAccessor(points.at(-1) ?? points[0]);
          return (
            <div key={item.key} className="training-cockpit-chart-legend__item">
              <span className="training-cockpit-chart-legend__swatch" style={{ background: item.color }} />
              <span>{item.label}</span>
              <strong>{value === null ? '—' : value.toFixed(item.key === 'learningRate' ? 6 : 4)}</strong>
            </div>
          );
        })}
      </div>
    </div>
  );
}
