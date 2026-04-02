export default function StepIndicator({
  steps,
  current
}: {
  steps: string[];
  current: number;
}) {
  return (
    <div className="stepper">
      {steps.map((step, index) => (
        <div key={step} className={`step ${index <= current ? 'active' : ''}`}>
          <span className="dot">{index + 1}</span>
          <span>{step}</span>
        </div>
      ))}
    </div>
  );
}
