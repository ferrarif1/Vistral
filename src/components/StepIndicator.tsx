import { useI18n } from '../i18n/I18nProvider';
import ProgressStepper from './ui/ProgressStepper';

interface StepIndicatorProps {
  steps: string[];
  current: number;
}

export default function StepIndicator({ steps, current }: StepIndicatorProps) {
  const { t } = useI18n();
  const total = steps.length;
  const currentDisplay = Math.min(current + 1, total);

  return (
    <ProgressStepper
      steps={steps}
      current={current}
      title={t('Step {current} of {total}', { current: currentDisplay, total })}
      caption={t('Multi-step workflow')}
    />
  );
}
