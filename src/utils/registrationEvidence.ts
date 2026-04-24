type MaybeBoolean = boolean | null | undefined;

export type RegistrationEvidenceLevel =
  | 'standard'
  | 'calibrated'
  | 'compatibility'
  | 'pending';

export type RegistrationGateLevel = 'standard' | 'override' | 'pending';

const toNormalizedText = (value: unknown): string => {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().toLowerCase();
};

export const resolveRegistrationEvidenceLevel = (value: unknown): RegistrationEvidenceLevel => {
  if (
    value &&
    typeof value === 'object' &&
    'registration_evidence_level' in value &&
    typeof (value as { registration_evidence_level?: unknown }).registration_evidence_level === 'string'
  ) {
    const fromLevel = toNormalizedText(
      (value as { registration_evidence_level?: string }).registration_evidence_level
    );
    if (
      fromLevel === 'standard' ||
      fromLevel === 'calibrated' ||
      fromLevel === 'compatibility' ||
      fromLevel === 'pending'
    ) {
      return fromLevel;
    }
  }
  if (
    value &&
    typeof value === 'object' &&
    'registration_evidence_mode' in value &&
    typeof (value as { registration_evidence_mode?: unknown }).registration_evidence_mode === 'string'
  ) {
    return resolveRegistrationEvidenceLevel(
      (value as { registration_evidence_mode?: string }).registration_evidence_mode
    );
  }
  const normalized = toNormalizedText(value);
  if (!normalized) {
    return 'pending';
  }
  if (normalized === 'real' || normalized === 'standard') {
    return 'standard';
  }
  if (normalized === 'real_probe' || normalized === 'calibrated') {
    return 'calibrated';
  }
  if (normalized === 'non_real_local_command' || normalized === 'compatibility') {
    return 'compatibility';
  }
  return 'pending';
};

export const isStandardEvidenceLevel = (value: unknown): boolean =>
  resolveRegistrationEvidenceLevel(value) === 'standard';

export const isCalibratedEvidenceLevel = (value: unknown): boolean =>
  resolveRegistrationEvidenceLevel(value) === 'calibrated';

export const resolveRegistrationGateLevel = (input: {
  registration_gate_status?: unknown;
  registration_gate_exempted?: MaybeBoolean;
  registration_evidence_mode?: unknown;
  registration_evidence_level?: unknown;
}): RegistrationGateLevel => {
  const gateStatus = toNormalizedText(input.registration_gate_status);
  if (gateStatus === 'override') {
    return 'override';
  }
  if (gateStatus === 'standard') {
    return 'standard';
  }
  if (gateStatus === 'pending') {
    return 'pending';
  }
  if (input.registration_gate_exempted === true) {
    return 'override';
  }
  if (input.registration_gate_exempted === false) {
    const evidenceLevel = resolveRegistrationEvidenceLevel(
      input.registration_evidence_level ?? input.registration_evidence_mode
    );
    if (evidenceLevel === 'standard' || evidenceLevel === 'calibrated') {
      return 'standard';
    }
    return 'pending';
  }
  const evidenceLevel = resolveRegistrationEvidenceLevel(
    input.registration_evidence_level ?? input.registration_evidence_mode
  );
  if (evidenceLevel === 'standard' || evidenceLevel === 'calibrated') {
    return 'standard';
  }
  return 'pending';
};

export const isStandardGateReady = (input: {
  registration_gate_status?: unknown;
  registration_gate_exempted?: MaybeBoolean;
  registration_evidence_mode?: unknown;
  registration_evidence_level?: unknown;
}): boolean =>
  resolveRegistrationGateLevel(input) === 'standard' &&
  resolveRegistrationEvidenceLevel(
    input.registration_evidence_level ?? input.registration_evidence_mode
  ) === 'standard';
