interface ProgressStepperProps {
  steps: string[];
  current: number;
  title?: string;
  caption?: string;
  className?: string;
}

const joinClasses = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ');

export default function ProgressStepper({
  steps,
  current,
  title,
  caption,
  className
}: ProgressStepperProps) {
  const total = steps.length;
  const currentDisplay = Math.min(current + 1, total);

  return (
    <section className={joinClasses('ui-stepper', className)}>
      <div className="ui-stepper-header">
        <strong>{title ?? `Step ${currentDisplay} of ${total}`}</strong>
        {caption ? <span>{caption}</span> : null}
      </div>
      <div className="ui-stepper-track" aria-label={title ?? `Step ${currentDisplay} of ${total}`}>
        {steps.map((step, index) => {
          const completed = index < current;
          const active = index === current;
          return (
            <div
              key={step}
              className={joinClasses(
                'ui-stepper-step',
                completed && 'is-complete',
                active && 'is-active'
              )}
            >
              <span className="ui-stepper-dot">{completed ? '✓' : index + 1}</span>
              <span className="ui-stepper-label">{step}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
