const kib = 1024;
const mib = kib * 1024;
const gib = mib * 1024;

export const UPLOAD_SOFT_LIMIT_BYTES = 120 * mib;
export const UPLOAD_SOFT_LIMIT_LABEL = '120 MB';

export interface UploadLikeFile {
  name: string;
  size: number;
}

export const formatByteSize = (byteSize: number): string => {
  if (!Number.isFinite(byteSize) || byteSize <= 0) {
    return '0 B';
  }

  if (byteSize >= gib) {
    return `${(byteSize / gib).toFixed(1)} GB`;
  }

  if (byteSize >= mib) {
    return `${(byteSize / mib).toFixed(1)} MB`;
  }

  if (byteSize >= kib) {
    return `${(byteSize / kib).toFixed(1)} KB`;
  }

  return `${Math.round(byteSize)} B`;
};

export const findOversizedUpload = <T extends UploadLikeFile>(files: readonly T[]): T | null =>
  files.find((file) => Number.isFinite(file.size) && file.size > UPLOAD_SOFT_LIMIT_BYTES) ?? null;
