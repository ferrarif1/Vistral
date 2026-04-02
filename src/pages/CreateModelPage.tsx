import { useState } from 'react';
import StepIndicator from '../components/StepIndicator';
import AdvancedSection from '../components/AdvancedSection';
import { api } from '../services/api';
import StateBlock from '../components/StateBlock';

const STEPS = ['Metadata', 'File', 'Parameters', 'Review'];

export default function CreateModelPage() {
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [result, setResult] = useState('');

  const submit = async () => {
    const created = await api.createModel({ name, description, visibility: 'private' });
    setResult(`Created ${created.name} (${created.id})`);
  };

  return (
    <div className="stack">
      <h2>Create Model Wizard</h2>
      <StepIndicator steps={STEPS} current={step} />
      <section className="card">
        <label>Model Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Description<textarea value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      </section>
      <AdvancedSection>
        <label>Learning Rate<input defaultValue="0.001" /></label>
        <label>Batch Size<input defaultValue="16" /></label>
      </AdvancedSection>
      <div className="row gap">
        <button disabled={step === 0} onClick={() => setStep((s) => s - 1)}>Back</button>
        <button disabled={step === STEPS.length - 1} onClick={() => setStep((s) => s + 1)}>Next</button>
        <button onClick={submit}>Submit Draft</button>
      </div>
      {result ? <StateBlock variant="success" title="Model Draft Created" description={result} /> : null}
    </div>
  );
}
