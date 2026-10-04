import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ArrowLeft, ArrowRight, Check, FileText, Sparkles, Upload } from 'lucide-react';
import toast from 'react-hot-toast';
import { interviewAPI, resumeAPI } from '@/services/api';
import { EXPERIENCE_LEVELS, QUESTION_TYPES } from '@/constants';
import { BILLING_ME_KEY, useBillingMe } from '@/hooks/use-billing';
import { Alert, Button, Card, Field, Input, PageHeader, Pill, Skeleton, Textarea } from '@/components/ui';
import { cn, getErrorMessage } from '@/utils';

const STEPS = ['Role', 'Preferences', 'Resume', 'Review'];
const JD_MIN = 50;
const JD_MAX = 5000;

function StepIndicator({ step }) {
  return (
    <ol className="flex flex-wrap items-center gap-2" aria-label="Progress">
      {STEPS.map((label, i) => {
        const done = i < step;
        const current = i === step;
        return (
          <li key={label} className="flex items-center gap-2" aria-current={current ? 'step' : undefined}>
            <span
              className={cn(
                'flex items-center gap-2 rounded-full py-1.5 pl-1.5 pr-3.5 font-mono text-[11px] uppercase tracking-mono transition-colors',
                current ? 'bg-ink text-white' : done ? 'bg-lime text-ink' : 'bg-stone text-muted',
              )}
            >
              <span className={cn('grid h-6 w-6 place-items-center rounded-full text-[10.5px]', current ? 'bg-lime text-ink' : done ? 'bg-ink text-lime' : 'bg-white text-muted')}>
                {done ? <Check size={12} /> : i + 1}
              </span>
              {label}
            </span>
            {i < STEPS.length - 1 && <span className="hidden h-px w-5 bg-line sm:block" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}

export default function NewInterviewPage() {
  const navigate = useNavigate();
  const { state } = useLocation();
  const prefill = state?.prefill; // from the job board / recommendations ("Practice for this role")
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [selectedResume, setSelectedResume] = useState(null);
  const [selectedTypes, setSelectedTypes] = useState(['technical', 'behavioral']);
  const [experienceLevel, setExperienceLevel] = useState('mid');
  const [phase, setPhase] = useState('idle'); // idle | creating | generating
  const [createdId, setCreatedId] = useState(null);
  const [submitError, setSubmitError] = useState(null); // { message, status }

  const { register, handleSubmit, watch, trigger, formState: { errors } } = useForm({
    mode: 'onTouched',
    defaultValues: {
      jobTitle: prefill?.jobTitle || '',
      company: prefill?.company || '',
      jobDescription: (prefill?.jobDescription || '').slice(0, JD_MAX),
      numberOfQuestions: 8,
    },
  });
  const [jobTitle, company, jobDescription, numberOfQuestions] = watch(['jobTitle', 'company', 'jobDescription', 'numberOfQuestions']);

  const resumesQuery = useQuery({ queryKey: ['resumes'], queryFn: () => resumeAPI.getAll().then((r) => r.data.resumes || []) });
  const resumes = resumesQuery.data || [];
  const billing = useBillingMe();
  const allowance = billing.data?.allowance;

  // Preselect the default resume once resumes load.
  useEffect(() => {
    if (selectedResume === null && resumes.length) {
      const def = resumes.find((r) => r.isDefault);
      if (def) setSelectedResume(def._id);
    }
  }, [resumes]);

  const toggleType = (type) => {
    setSelectedTypes((prev) => (prev.includes(type) ? (prev.length > 1 ? prev.filter((t) => t !== type) : prev) : [...prev, type]));
  };

  const next = async () => {
    if (step === 0) {
      const ok = await trigger(['jobTitle', 'jobDescription', 'company']);
      if (!ok) return;
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const generate = async (interviewId) => {
    setPhase('generating');
    const toastId = toast.loading('Writing questions from your resume and the role…');
    try {
      await interviewAPI.generateQuestions(interviewId);
      toast.success('Your interview is ready', { id: toastId });
      queryClient.invalidateQueries({ queryKey: BILLING_ME_KEY });
      queryClient.invalidateQueries({ queryKey: ['interviews'] });
      navigate(`/interviews/${interviewId}/session`);
    } catch (err) {
      toast.dismiss(toastId);
      setSubmitError({ message: getErrorMessage(err, 'Question generation failed. Please retry.'), status: err.response?.status });
      setPhase('idle');
    }
  };

  const onSubmit = async (formData) => {
    setSubmitError(null);
    if (createdId) return generate(createdId); // retry generation without creating a duplicate
    setPhase('creating');
    try {
      const { data } = await interviewAPI.create({
        jobTitle: formData.jobTitle.trim(),
        company: formData.company.trim() || undefined,
        jobDescription: formData.jobDescription.trim(),
        numberOfQuestions: Number(formData.numberOfQuestions),
        experienceLevel,
        questionTypes: selectedTypes,
        resumeId: selectedResume,
      });
      setCreatedId(data.interview._id);
      queryClient.invalidateQueries({ queryKey: ['interviews'] });
      await generate(data.interview._id);
    } catch (err) {
      setSubmitError({ message: getErrorMessage(err, 'Couldn’t create the interview'), status: err.response?.status });
      setPhase('idle');
      if (err.response?.status === 400) setStep(0);
    }
  };

  const busy = phase !== 'idle';
  const selectedResumeDoc = resumes.find((r) => r._id === selectedResume);
  const jdLength = jobDescription?.trim().length ?? 0;

  return (
    <div className="space-y-8 animate-fade-in">
      <PageHeader
        eyebrow="New interview"
        title="Build an interview for one role"
        description="Paste the job description, pick what to practise, and optionally add a resume to tailor the questions."
      />

      <StepIndicator step={step} />

      {prefill && step === 0 && (
        <Alert tone="info" icon={Sparkles}>
          We filled in the role from the job listing. Paste the full description if you have it — listings are often summarised.
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
        <form
          noValidate
          onSubmit={(e) => {
            // Enter in an earlier step advances the wizard instead of generating.
            if (step < STEPS.length - 1) { e.preventDefault(); next(); return; }
            handleSubmit(onSubmit)(e);
          }}
        >
          <Card className="p-6 sm:p-8">
            {step === 0 && (
              <div className="space-y-5 animate-fade-in">
                <div>
                  <h2 className="text-[24px] font-medium tracking-tight3">The role</h2>
                  <p className="mt-1 text-[14.5px] text-muted">The more of the job description you paste, the sharper the questions.</p>
                </div>
                <Field label="Job title" required error={errors.jobTitle?.message}>
                  <Input
                    placeholder="e.g. Product Analyst"
                    {...register('jobTitle', {
                      validate: (v) => v.trim().length > 0 || 'Enter the job title',
                      maxLength: { value: 120, message: 'Keep the title under 120 characters' },
                    })}
                  />
                </Field>
                <Field label="Company" hint="Optional" error={errors.company?.message}>
                  <Input placeholder="e.g. a fintech startup" {...register('company', { maxLength: { value: 120, message: 'Keep it under 120 characters' } })} />
                </Field>
                <Field
                  label="Job description"
                  required
                  error={errors.jobDescription?.message}
                  labelRight={<span className={cn('font-mono text-[11px] tabular', jdLength < JD_MIN ? 'text-muted' : 'text-lime-ok')}>{jdLength}/{JD_MAX}</span>}
                  hint={`Paste at least ${JD_MIN} characters.`}
                >
                  <Textarea
                    rows={9}
                    maxLength={JD_MAX}
                    placeholder="Paste the full job description — responsibilities, requirements, nice-to-haves…"
                    {...register('jobDescription', {
                      validate: (v) => v.trim().length >= JD_MIN || `Paste at least ${JD_MIN} characters of the job description`,
                    })}
                  />
                </Field>
              </div>
            )}

            {step === 1 && (
              <div className="space-y-7 animate-fade-in">
                <div>
                  <h2 className="text-[24px] font-medium tracking-tight3">Preferences</h2>
                  <p className="mt-1 text-[14.5px] text-muted">Match the level you’re interviewing for.</p>
                </div>
                <fieldset>
                  <legend className="mb-3 text-[13.5px] font-medium">Experience level</legend>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {EXPERIENCE_LEVELS.map(({ value, label, sub }) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={experienceLevel === value}
                        onClick={() => setExperienceLevel(value)}
                        className={cn(
                          'rounded-r18 border p-4 text-left transition-colors',
                          experienceLevel === value ? 'border-ink bg-ink text-white' : 'border-line bg-white hover:border-ink',
                        )}
                      >
                        <span className="block text-[15px] font-medium">{label}</span>
                        <span className={cn('mt-0.5 block text-[12.5px]', experienceLevel === value ? 'text-on-dark' : 'text-muted')}>{sub}</span>
                      </button>
                    ))}
                  </div>
                </fieldset>
                <fieldset>
                  <legend className="mb-3 text-[13.5px] font-medium">Question types <span className="font-normal text-muted">· pick at least one</span></legend>
                  <div className="flex flex-wrap gap-2">
                    {QUESTION_TYPES.map(({ value, label }) => (
                      <button key={value} type="button" className="chip-toggle" aria-pressed={selectedTypes.includes(value)} onClick={() => toggleType(value)}>
                        {selectedTypes.includes(value) && <Check size={13} aria-hidden="true" />}
                        {label}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <div>
                  <label htmlFor="question-count" className="mb-3 flex items-baseline justify-between text-[13.5px] font-medium">
                    Number of questions
                    <span className="text-[28px] font-medium tracking-tight3 tabular">{numberOfQuestions}</span>
                  </label>
                  <input
                    id="question-count"
                    type="range"
                    min="3"
                    max="20"
                    step="1"
                    className="w-full accent-ink"
                    {...register('numberOfQuestions', { valueAsNumber: true })}
                  />
                  <div className="mt-1 flex justify-between font-mono text-[11px] text-muted"><span>3</span><span>~{Math.round(Number(numberOfQuestions) * 2.5)} min</span><span>20</span></div>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-5 animate-fade-in">
                <div>
                  <h2 className="text-[24px] font-medium tracking-tight3">Ground it in your resume</h2>
                  <p className="mt-1 text-[14.5px] text-muted">We map the role’s requirements to experience you already have. Optional, but strongly recommended.</p>
                </div>
                {resumesQuery.isLoading ? (
                  <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-16 rounded-r18" />)}</div>
                ) : resumesQuery.isError ? (
                  <Alert tone="error" icon={AlertCircle} action={<Button size="sm" variant="soft" onClick={() => resumesQuery.refetch()}>Retry</Button>}>
                    Couldn’t load your resumes.
                  </Alert>
                ) : (
                  <div className="space-y-2" role="radiogroup" aria-label="Resume">
                    {resumes.map((r) => (
                      <button
                        key={r._id}
                        type="button"
                        role="radio"
                        aria-checked={selectedResume === r._id}
                        onClick={() => setSelectedResume(r._id)}
                        className={cn('flex w-full items-center gap-3 rounded-r18 border p-4 text-left transition-colors', selectedResume === r._id ? 'border-ink bg-white shadow-card ring-1 ring-ink' : 'border-line bg-white hover:border-ink')}
                      >
                        <span className={cn('grid h-10 w-10 flex-shrink-0 place-items-center rounded-r14', selectedResume === r._id ? 'bg-lime' : 'bg-stone-2')}>
                          <FileText size={17} aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[15px] font-medium">{r.originalName}</span>
                          <span className="mt-0.5 block text-[12.5px] text-muted">
                            {r.parseStatus === 'parsed' ? 'Text extracted' : r.parseStatus === 'failed' ? 'Text extraction failed' : 'Processing'}
                            {r.parsedData?.skills?.length ? ` · ${r.parsedData.skills.length} skills found` : ''}
                          </span>
                        </span>
                        {r.isDefault && <Pill tone="lime" mono>Default</Pill>}
                      </button>
                    ))}
                    <button
                      type="button"
                      role="radio"
                      aria-checked={!selectedResume}
                      onClick={() => setSelectedResume(null)}
                      className={cn('w-full rounded-r18 border border-dashed p-4 text-left transition-colors', !selectedResume ? 'border-ink bg-white ring-1 ring-ink' : 'border-line bg-white/60 hover:border-ink')}
                    >
                      <span className="block text-[15px] font-medium">Job description only</span>
                      <span className="mt-0.5 block text-[12.5px] text-muted">Questions come from the role, not your experience.</span>
                    </button>
                    {resumes.length === 0 && (
                      <p className="pt-2 text-[14px] text-muted">
                        No resume yet. <Link to="/resumes" className="link inline-flex items-center gap-1"><Upload size={13} /> Upload one</Link> then come back — your answers here are kept only until you leave this page.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {step === 3 && (
              <div className="space-y-5 animate-fade-in">
                <div>
                  <h2 className="text-[24px] font-medium tracking-tight3">Review and generate</h2>
                  <p className="mt-1 text-[14.5px] text-muted">Generation usually takes 5–20 seconds.</p>
                </div>
                <dl className="divide-y divide-line-2 rounded-r18 border border-line-2">
                  {[
                    ['Job title', jobTitle],
                    ['Company', company || 'Not specified'],
                    ['Level', EXPERIENCE_LEVELS.find((l) => l.value === experienceLevel)?.label],
                    ['Question types', selectedTypes.map((t) => QUESTION_TYPES.find((q) => q.value === t)?.label).join(', ')],
                    ['Questions', numberOfQuestions],
                    ['Resume', selectedResumeDoc?.originalName || 'None — job description only'],
                  ].map(([k, v]) => (
                    <div key={k} className="flex items-start justify-between gap-6 px-4 py-3 text-[14px]">
                      <dt className="text-muted">{k}</dt>
                      <dd className="max-w-[60%] break-words text-right font-medium">{v}</dd>
                    </div>
                  ))}
                </dl>
                {allowance && allowance.remaining === 0 && !createdId && (
                  <Alert tone="warn" icon={AlertCircle} title="You’ve used this period’s interviews">
                    Generating needs one interview from your allowance. <Link to="/pricing" className="link">See passes</Link>.
                  </Alert>
                )}
              </div>
            )}

            {submitError && (
              <Alert tone="error" icon={AlertCircle} className="mt-6" title={submitError.status === 402 ? 'Interview allowance used up' : 'That didn’t work'}>
                {submitError.message}{' '}
                {submitError.status === 402 && <Link to="/pricing" className="link">Choose a pass</Link>}
                {createdId && submitError.status !== 402 && ' Your interview is saved — generate again to retry.'}
              </Alert>
            )}

            <div className="mt-8 flex items-center justify-between gap-3 border-t border-line-2 pt-6">
              <Button variant="ghost" icon={ArrowLeft} onClick={() => setStep((s) => s - 1)} disabled={step === 0 || busy}>
                Back
              </Button>
              {step < STEPS.length - 1 ? (
                // Distinct keys: reusing one <button> element would let the click that
                // advances to the last step also submit the form once it becomes type=submit.
                <Button key="continue" variant="ink" iconRight={ArrowRight} onClick={next}>
                  Continue
                </Button>
              ) : (
                <Button key="generate" type="submit" variant="lime" icon={busy ? undefined : Sparkles} loading={busy}>
                  {phase === 'creating' ? 'Saving…' : phase === 'generating' ? 'Generating…' : createdId ? 'Retry generation' : 'Generate interview'}
                </Button>
              )}
            </div>
          </Card>
        </form>

        {/* Live summary */}
        <aside className="h-fit rounded-r24 bg-ink p-6 text-white lg:sticky lg:top-6">
          <p className="mono-label text-lime">Your interview</p>
          <p className="mt-3 text-[22px] font-medium leading-tight tracking-tight1">{jobTitle?.trim() || 'Untitled role'}</p>
          <p className="mt-1 text-[13.5px] text-on-dark">{company?.trim() || 'Company not specified'}</p>
          <div className="mt-6 space-y-3 text-[14px]">
            <div className="flex justify-between"><span className="text-on-dark">Level</span><span>{EXPERIENCE_LEVELS.find((l) => l.value === experienceLevel)?.label}</span></div>
            <div className="flex justify-between"><span className="text-on-dark">Questions</span><span className="tabular">{numberOfQuestions}</span></div>
            <div className="flex justify-between gap-4"><span className="text-on-dark">Resume</span><span className="truncate">{selectedResumeDoc ? 'Linked' : 'Not linked'}</span></div>
            <div className="flex justify-between"><span className="text-on-dark">Job description</span><span className="tabular">{jdLength} chars</span></div>
          </div>
          <div className="mt-6 flex flex-wrap gap-1.5">
            {selectedTypes.map((t) => <span key={t} className="rounded-full bg-white/10 px-3 py-1.5 text-[12px]">{QUESTION_TYPES.find((q) => q.value === t)?.label}</span>)}
          </div>
          {allowance && (
            <p className="mt-6 border-t border-ink-line pt-4 text-[13px] text-on-dark">
              {allowance.remaining} of {allowance.limit} interviews left {billing.data?.subscription ? 'on your pass' : 'this month'}.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
