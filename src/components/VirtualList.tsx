import { useMemo, useState, type CSSProperties, type ReactNode, type UIEvent } from 'react';

interface VirtualListProps<T> {
  items: T[];
  itemHeight: number;
  height: number;
  itemKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
  overscan?: number;
  className?: string;
  listClassName?: string;
  rowClassName?: string;
  ariaLabel?: string;
}

export default function VirtualList<T>({
  items,
  itemHeight,
  height,
  itemKey,
  renderItem,
  overscan = 4,
  className,
  listClassName,
  rowClassName,
  ariaLabel
}: VirtualListProps<T>) {
  const [scrollTop, setScrollTop] = useState(0);

  const totalHeight = items.length * itemHeight;
  const viewportHeight = Math.max(height, itemHeight);

  const windowState = useMemo(() => {
    const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
    const endIndex = Math.min(
      items.length,
      Math.ceil((scrollTop + viewportHeight) / itemHeight) + overscan
    );

    return {
      startIndex,
      endIndex,
      topSpacerHeight: startIndex * itemHeight,
      bottomSpacerHeight: Math.max(0, totalHeight - endIndex * itemHeight)
    };
  }, [itemHeight, items.length, overscan, scrollTop, totalHeight, viewportHeight]);

  const visibleItems = items.slice(windowState.startIndex, windowState.endIndex);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  };

  const viewportStyle: CSSProperties = {
    height: viewportHeight
  };
  const topSpacerStyle: CSSProperties = {
    height: windowState.topSpacerHeight
  };
  const bottomSpacerStyle: CSSProperties = {
    height: windowState.bottomSpacerHeight
  };
  const rowStyle: CSSProperties = {
    minHeight: itemHeight
  };

  return (
    <div
      className={className ? `virtual-list-viewport ${className}` : 'virtual-list-viewport'}
      style={viewportStyle}
      onScroll={onScroll}
      role="list"
      aria-label={ariaLabel}
    >
      <div className={listClassName ? `virtual-list-body ${listClassName}` : 'virtual-list-body'}>
        {windowState.topSpacerHeight > 0 ? <div style={topSpacerStyle} aria-hidden="true" /> : null}
        {visibleItems.map((item, visibleIndex) => {
          const absoluteIndex = windowState.startIndex + visibleIndex;
          return (
            <div
              key={itemKey(item, absoluteIndex)}
              className={rowClassName ? `virtual-list-row ${rowClassName}` : 'virtual-list-row'}
              style={rowStyle}
              role="listitem"
            >
              {renderItem(item, absoluteIndex)}
            </div>
          );
        })}
        {windowState.bottomSpacerHeight > 0 ? <div style={bottomSpacerStyle} aria-hidden="true" /> : null}
      </div>
    </div>
  );
}
