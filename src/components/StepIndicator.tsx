interface StepIndicatorProps {
  steps: string[];
  current: number;
}

export default function StepIndicator({ steps, current }: StepIndicatorProps) {
  const total = steps.length;
  const currentDisplay = Math.min(current + 1, total);

  return (
    <section className="card stack">
      <div className="row between">
        <strong>
          Step {currentDisplay} of {total}
        </strong>
        <span className="muted">Multi-step workflow</span>
      </div>
      <div className="stepper">
        {steps.map((step, index) => {
          const isCompleted = index < current;
          const isActive = index === current;
          return (
            <div
              key={step}
              className={`step${isCompleted ? ' completed' : ''}${isActive ? ' active' : ''}`}
            >
              <span className="dot">{isCompleted ? '✓' : index + 1}</span>
              <span>{step}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
