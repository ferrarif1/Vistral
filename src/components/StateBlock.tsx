export default function StateBlock({
  variant,
  title,
  description
}: {
  variant: 'empty' | 'loading' | 'error' | 'success';
  title: string;
  description: string;
}) {
  return (
    <div className={`state-block ${variant}`}>
      <h4>{title}</h4>
      <p>{description}</p>
    </div>
  );
}
