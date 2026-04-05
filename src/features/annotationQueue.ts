import type { AnnotationStatus, AnnotationWithReview, DatasetItemRecord } from '../../shared/domain';

export type AnnotationQueueFilter = 'all' | 'needs_work' | 'in_review' | 'rejected' | 'approved';

export type AnnotationQueueSummary = {
  total: number;
  unannotated: number;
  in_progress: number;
  annotated: number;
  in_review: number;
  approved: number;
  rejected: number;
  needs_work: number;
};

export const annotationQueueFilters: AnnotationQueueFilter[] = [
  'all',
  'needs_work',
  'in_review',
  'rejected',
  'approved'
];

export const normalizeAnnotationQueueFilter = (value: string | null | undefined): AnnotationQueueFilter => {
  if (value === 'needs_work' || value === 'in_review' || value === 'rejected' || value === 'approved') {
    return value;
  }

  return 'all';
};

export const getAnnotationByItemId = (
  annotations: AnnotationWithReview[]
): Map<string, AnnotationWithReview> =>
  new Map(annotations.map((annotation) => [annotation.dataset_item_id, annotation]));

export const getItemAnnotationStatus = (
  itemId: string,
  annotationByItemId: Map<string, AnnotationWithReview>
): AnnotationStatus => annotationByItemId.get(itemId)?.status ?? 'unannotated';

export const matchesAnnotationQueue = (
  status: AnnotationStatus,
  filter: AnnotationQueueFilter
): boolean => {
  if (filter === 'all') {
    return true;
  }

  if (filter === 'needs_work') {
    return status === 'unannotated' || status === 'in_progress' || status === 'annotated';
  }

  return status === filter;
};

export const filterItemsByAnnotationQueue = (
  items: DatasetItemRecord[],
  annotations: AnnotationWithReview[],
  filter: AnnotationQueueFilter
): DatasetItemRecord[] => {
  const annotationByItemId = getAnnotationByItemId(annotations);
  return items.filter((item) => matchesAnnotationQueue(getItemAnnotationStatus(item.id, annotationByItemId), filter));
};

export const summarizeAnnotationQueues = (
  items: DatasetItemRecord[],
  annotations: AnnotationWithReview[]
): AnnotationQueueSummary => {
  const summary: AnnotationQueueSummary = {
    total: items.length,
    unannotated: 0,
    in_progress: 0,
    annotated: 0,
    in_review: 0,
    approved: 0,
    rejected: 0,
    needs_work: 0
  };
  const annotationByItemId = getAnnotationByItemId(annotations);

  items.forEach((item) => {
    const status = getItemAnnotationStatus(item.id, annotationByItemId);
    summary[status] += 1;
    if (matchesAnnotationQueue(status, 'needs_work')) {
      summary.needs_work += 1;
    }
  });

  return summary;
};

export const annotationStatusSortWeight: Record<AnnotationStatus, number> = {
  in_review: 0,
  rejected: 1,
  annotated: 2,
  in_progress: 3,
  unannotated: 4,
  approved: 5
};
