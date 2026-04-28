import JSZip from 'jszip';
import type { DatasetRecord } from '../../shared/domain';

export type DatasetBundleImportFormat = 'yolo' | 'coco' | 'labelme' | 'ocr';

export interface DatasetBundleFileEntry {
  file: File;
  relativePath: string;
  basename: string;
  extension: string;
}

export interface DatasetBundleCandidate {
  sourceLabel: string;
  entries: DatasetBundleFileEntry[];
  imageEntries: DatasetBundleFileEntry[];
  annotationEntries: DatasetBundleFileEntry[];
  duplicateImageBasenames: string[];
  supportedFormats: DatasetBundleImportFormat[];
}

export interface DatasetBundleImportArtifact {
  file: File;
  format: DatasetBundleImportFormat;
  recordCount: number;
}

const imageExtensions = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.bmp',
  '.gif',
  '.tif',
  '.tiff'
]);

const annotationExtensions = new Set(['.json', '.txt']);

const normalizeRelativePath = (value: string): string =>
  value
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .join('/')
    .trim();

const basenameFromPath = (value: string): string => {
  const normalized = normalizeRelativePath(value);
  const parts = normalized.split('/');
  return (parts[parts.length - 1] ?? normalized).trim();
};

const extensionFromPath = (value: string): string => {
  const basename = basenameFromPath(value);
  const dotIndex = basename.lastIndexOf('.');
  if (dotIndex < 0) {
    return '';
  }
  return basename.slice(dotIndex).toLowerCase();
};

const stemFromBasename = (value: string): string => {
  const dotIndex = value.lastIndexOf('.');
  if (dotIndex < 0) {
    return value.toLowerCase();
  }
  return value.slice(0, dotIndex).toLowerCase();
};

const looksLikeImage = (path: string): boolean => imageExtensions.has(extensionFromPath(path));

const looksLikeAnnotation = (path: string): boolean => annotationExtensions.has(extensionFromPath(path));

const fileText = async (file: File): Promise<string> => {
  return file.text();
};

const parseJson = async (file: File): Promise<unknown> => {
  return JSON.parse(await fileText(file));
};

const inferSupportedFormats = async (
  dataset: DatasetRecord,
  annotationEntries: DatasetBundleFileEntry[]
): Promise<DatasetBundleImportFormat[]> => {
  if (annotationEntries.length === 0) {
    return [];
  }

  if (dataset.task_type === 'ocr') {
    return ['ocr'];
  }

  const jsonEntries = annotationEntries.filter((entry) => entry.extension === '.json');
  if (jsonEntries.length > 0) {
    for (const entry of jsonEntries) {
      try {
        const parsed = await parseJson(entry.file);
        if (
          parsed &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed) &&
          'images' in parsed &&
          'annotations' in parsed &&
          'categories' in parsed
        ) {
          return ['coco', 'yolo'];
        }
        if (
          Array.isArray(parsed) &&
          parsed.some(
            (item) =>
              item &&
              typeof item === 'object' &&
              'imagePath' in item &&
              'shapes' in item
          )
        ) {
          return ['labelme'];
        }
        if (
          parsed &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed) &&
          'imagePath' in parsed &&
          'shapes' in parsed
        ) {
          return ['labelme'];
        }
      } catch {
        // Ignore parse failure during format suggestion. The explicit import step will surface a real error.
      }
    }
  }

  if (annotationEntries.some((entry) => entry.extension === '.txt')) {
    return ['yolo'];
  }

  return ['yolo', 'coco', 'labelme'];
};

const createFileWithPath = (file: File, relativePath: string): File => {
  const normalizedPath = normalizeRelativePath(relativePath) || file.name;
  if (normalizedPath === file.name) {
    return file;
  }
  return new File([file], normalizedPath, {
    type: file.type,
    lastModified: file.lastModified
  });
};

const createBundleEntries = async (
  sourceLabel: string,
  files: Array<{ file: File; relativePath: string }>
): Promise<DatasetBundleCandidate> => {
  const entries = files
    .map(({ file, relativePath }) => {
      const normalizedPath = normalizeRelativePath(relativePath) || file.name;
      const basename = basenameFromPath(normalizedPath);
      return {
        file: createFileWithPath(file, normalizedPath),
        relativePath: normalizedPath,
        basename,
        extension: extensionFromPath(normalizedPath)
      };
    })
    .filter((entry) => entry.basename.length > 0);

  const imageEntries = entries.filter((entry) => looksLikeImage(entry.relativePath));
  const annotationEntries = entries.filter((entry) => looksLikeAnnotation(entry.relativePath));
  const basenameCounts = new Map<string, number>();
  imageEntries.forEach((entry) => {
    const key = entry.basename.toLowerCase();
    basenameCounts.set(key, (basenameCounts.get(key) ?? 0) + 1);
  });
  const duplicateImageBasenames = Array.from(basenameCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([basename]) => basename)
    .sort((left, right) => left.localeCompare(right));

  return {
    sourceLabel,
    entries,
    imageEntries,
    annotationEntries,
    duplicateImageBasenames,
    supportedFormats: []
  };
};

export const buildDatasetBundleFromFolderFiles = async (
  dataset: DatasetRecord,
  files: File[],
  sourceLabel = 'folder'
): Promise<DatasetBundleCandidate> => {
  const preparedFiles = files.map((file) => {
    const relativePath =
      typeof (file as File & { webkitRelativePath?: string }).webkitRelativePath === 'string' &&
      (file as File & { webkitRelativePath?: string }).webkitRelativePath?.trim()
        ? (file as File & { webkitRelativePath?: string }).webkitRelativePath!.trim()
        : file.name;
    return { file, relativePath };
  });

  const candidate = await createBundleEntries(sourceLabel, preparedFiles);
  candidate.supportedFormats = await inferSupportedFormats(dataset, candidate.annotationEntries);
  return candidate;
};

export const buildDatasetBundleFromZipFile = async (
  dataset: DatasetRecord,
  zipFile: File
): Promise<DatasetBundleCandidate> => {
  const archive = await JSZip.loadAsync(zipFile);
  const files = await Promise.all(
    Object.values(archive.files)
      .filter((entry) => !entry.dir)
      .map(async (entry) => {
        const blob = await entry.async('blob');
        const filename = basenameFromPath(entry.name) || `zip-entry-${Date.now()}.bin`;
        const file = new File([blob], filename, {
          type: blob.type || guessMimeTypeFromPath(entry.name)
        });
        return {
          file,
          relativePath: entry.name
        };
      })
  );

  const candidate = await createBundleEntries(zipFile.name, files);
  candidate.supportedFormats = await inferSupportedFormats(dataset, candidate.annotationEntries);
  return candidate;
};

const guessMimeTypeFromPath = (value: string): string => {
  const extension = extensionFromPath(value);
  if (extension === '.png') {
    return 'image/png';
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    return 'image/jpeg';
  }
  if (extension === '.json') {
    return 'application/json';
  }
  if (extension === '.txt') {
    return 'text/plain';
  }
  if (extension === '.zip') {
    return 'application/zip';
  }
  return 'application/octet-stream';
};

const loadImageDimensions = async (file: File): Promise<{ width: number; height: number }> => {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    try {
      return { width: bitmap.width, height: bitmap.height };
    } finally {
      bitmap.close();
    }
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const size = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error(`Failed to inspect image ${file.name}.`));
      image.src = objectUrl;
    });
    return size;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};

const parseYoloTxtLine = (line: string): number[] | null => {
  const parts = line
    .trim()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 5) {
    return null;
  }
  const values = parts.map((part) => Number(part));
  if (values.some((value) => !Number.isFinite(value))) {
    return null;
  }
  return values;
};

const buildYoloArtifact = async (
  bundle: DatasetBundleCandidate,
  dataset: DatasetRecord
): Promise<DatasetBundleImportArtifact> => {
  const jsonAnnotation = bundle.annotationEntries.find((entry) => entry.extension === '.json');
  if (jsonAnnotation) {
    return {
      file: jsonAnnotation.file,
      format: 'yolo',
      recordCount: 1
    };
  }

  const imageByStem = new Map(bundle.imageEntries.map((entry) => [stemFromBasename(entry.basename), entry]));
  const txtEntries = bundle.annotationEntries.filter((entry) => entry.extension === '.txt');
  if (txtEntries.length === 0) {
    throw new Error('No YOLO annotation file was found in the selected bundle.');
  }

  const records: Array<{
    filename: string;
    boxes: Array<{ x: number; y: number; width: number; height: number; label: string; score: number }>;
  }> = [];

  for (const annotationEntry of txtEntries) {
    const imageEntry = imageByStem.get(stemFromBasename(annotationEntry.basename));
    if (!imageEntry) {
      continue;
    }
    const dimensions = await loadImageDimensions(imageEntry.file);
    const lines = (await fileText(annotationEntry.file))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const boxes = lines
      .map((line) => {
        const parts = parseYoloTxtLine(line);
        if (!parts) {
          return null;
        }
        const [rawClassId, centerX, centerY, widthRatio, heightRatio, rawScore] = parts;
        const classId = Math.trunc(rawClassId);
        const label = dataset.label_schema.classes[classId];
        if (!label) {
          throw new Error(`YOLO class index ${classId} is outside dataset label classes.`);
        }
        const width = Number((widthRatio * dimensions.width).toFixed(2));
        const height = Number((heightRatio * dimensions.height).toFixed(2));
        const x = Number(((centerX * dimensions.width) - width / 2).toFixed(2));
        const y = Number(((centerY * dimensions.height) - height / 2).toFixed(2));
        return {
          x,
          y,
          width,
          height,
          label,
          score: Number.isFinite(rawScore) ? Number(rawScore.toFixed(4)) : 1
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

    if (boxes.length > 0) {
      records.push({
        filename: imageEntry.basename,
        boxes
      });
    }
  }

  if (records.length === 0) {
    throw new Error('No YOLO annotations could be paired with uploaded images.');
  }

  return {
    file: new File([JSON.stringify(records, null, 2)], `bundle-yolo-import-${Date.now()}.json`, {
      type: 'application/json'
    }),
    format: 'yolo',
    recordCount: records.length
  };
};

const buildOcrArtifact = async (bundle: DatasetBundleCandidate): Promise<DatasetBundleImportArtifact> => {
  if (bundle.annotationEntries.length === 1) {
    const single = bundle.annotationEntries[0];
    if (single) {
      return {
        file: single.file,
        format: 'ocr',
        recordCount: 1
      };
    }
  }

  const imageByStem = new Map(bundle.imageEntries.map((entry) => [stemFromBasename(entry.basename), entry]));
  const records: Array<{ filename: string; lines: Array<{ text: string; confidence: number }> }> = [];

  for (const annotationEntry of bundle.annotationEntries) {
    const imageEntry = imageByStem.get(stemFromBasename(annotationEntry.basename));
    if (!imageEntry) {
      continue;
    }

    if (annotationEntry.extension === '.json') {
      const parsed = await parseJson(annotationEntry.file);
      if (Array.isArray(parsed)) {
        const lines = parsed
          .map((item) => {
            if (!item || typeof item !== 'object') {
              return null;
            }
            const text = typeof item.text === 'string' ? item.text.trim() : '';
            if (!text) {
              return null;
            }
            const confidence =
              typeof item.confidence === 'number' && Number.isFinite(item.confidence) ? item.confidence : 1;
            return { text, confidence };
          })
          .filter((item): item is NonNullable<typeof item> => Boolean(item));
        if (lines.length > 0) {
          records.push({ filename: imageEntry.basename, lines });
        }
      }
      continue;
    }

    const lines = (await fileText(annotationEntry.file))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ({ text: line, confidence: 1 }));
    if (lines.length > 0) {
      records.push({ filename: imageEntry.basename, lines });
    }
  }

  if (records.length === 0) {
    throw new Error('No OCR annotations could be paired with uploaded images.');
  }

  return {
    file: new File([JSON.stringify(records, null, 2)], `bundle-ocr-import-${Date.now()}.json`, {
      type: 'application/json'
    }),
    format: 'ocr',
    recordCount: records.length
  };
};

const buildLabelMeArtifact = async (bundle: DatasetBundleCandidate): Promise<DatasetBundleImportArtifact> => {
  const payloads: unknown[] = [];
  for (const entry of bundle.annotationEntries.filter((item) => item.extension === '.json')) {
    const parsed = await parseJson(entry.file);
    if (Array.isArray(parsed)) {
      payloads.push(...parsed);
    } else {
      payloads.push(parsed);
    }
  }

  const filtered = payloads.filter(
    (item) => item && typeof item === 'object' && 'imagePath' in item && 'shapes' in item
  );
  if (filtered.length === 0) {
    throw new Error('No LabelMe JSON annotations were found in the selected bundle.');
  }

  return {
    file: new File([JSON.stringify(filtered, null, 2)], `bundle-labelme-import-${Date.now()}.json`, {
      type: 'application/json'
    }),
    format: 'labelme',
    recordCount: filtered.length
  };
};

const buildCocoArtifact = async (bundle: DatasetBundleCandidate): Promise<DatasetBundleImportArtifact> => {
  const jsonEntries = bundle.annotationEntries.filter((entry) => entry.extension === '.json');
  if (jsonEntries.length === 0) {
    throw new Error('No COCO annotation JSON was found in the selected bundle.');
  }
  return {
    file: jsonEntries[0].file,
    format: 'coco',
    recordCount: 1
  };
};

export const buildBundleImportArtifact = async (
  bundle: DatasetBundleCandidate,
  format: DatasetBundleImportFormat,
  dataset: DatasetRecord
): Promise<DatasetBundleImportArtifact> => {
  if (bundle.imageEntries.length === 0) {
    throw new Error('No image files were found in the selected bundle.');
  }
  if (bundle.duplicateImageBasenames.length > 0) {
    throw new Error('Duplicate image filenames were found. Keep image basenames unique before import.');
  }

  if (format === 'yolo') {
    return buildYoloArtifact(bundle, dataset);
  }
  if (format === 'ocr') {
    return buildOcrArtifact(bundle);
  }
  if (format === 'labelme') {
    return buildLabelMeArtifact(bundle);
  }
  return buildCocoArtifact(bundle);
};
