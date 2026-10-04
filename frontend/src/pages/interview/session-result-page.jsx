import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronDown, Clock, Play, Plus, RotateCcw } from 'lucide-react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell, CartesianGrid } from 'recharts';
import { sessionAPI } from '@/services/api';
import { Button, Card, CHART, ChartTooltip, EmptyState, ErrorState, LoadingState, ProgressBar, ScorePill } from '@/components/ui';
import { cn, formatDate, getErrorMessage } from '@/utils';

const CATEGORY_LABEL = { technical: 'Technical', behavioral: 'Behavioral', situational: 'Situational', hr: 'HR', culture_fit: 'Culture fit', other: 'Other' };

function verdict(score) {
  if (score >= 75) return { label: 'Strong answers', note: 'Clear, specific and grounded. Keep sharpening the results you quote.' };
  if (score >= 50) return { label: 'Getting there', note: 'Good structure — add evidence and measurable outcomes to lift your score.' };
  return { label: 'Needs another pass', note: 'Use the per-answer notes below, then retry the questions that scored lowest.' };
}

function AnswerReview({ answer, index, category, open, onToggle }) {
  const score = answer.aiScore;
  const scored = typeof score === 'number';
  return (
    <li className="overflow-hidden rounded-r20 border border-line-2 bg-white">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-start justify-between gap-4 p-5 text-left transition-colors hover:bg-paper/60"
      >
        <div className="min-w-0">
          <p className="mono-label text-muted">Q{index + 1} · {CATEGORY_LABEL[category] || 'Question'}{answer.skipped ? ' · Skipped' : ''}</p>
          <p className="mt-2 text-[16px] font-medium leading-snug tracking-tight1">“{answer.questionText}”</p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-3">
          {scored ? <ScorePill score={score} outOf={10} /> : <span className="pill pill-stone">Not scored</span>}
          <ChevronDown size={18} className={cn('text-muted transition-transform', open && 'rotate-180')} aria-hidden="true" />
        </div>
      </button>
      {open && (
        <div className="space-y-3 border-t border-line-2 px-5 pb-5 pt-4 animate-fade-in">
          {answer.answerText ? (
            <div className="rounded-r14 bg-paper px-4 py-3.5 text-[14px] leading-[1.6] text-ink-soft">“{answer.answerText}”</div>
          ) : (
            <p className="text-[14px] text-muted">No answer was given for this question.</p>
          )}
          {answer.aiFeedback && (
            <div className="flex items-start gap-3 rounded-r14 bg-ink p-4 text-white">
              <span className="grid h-[22px] w-[22px] flex-shrink-0 place-items-center rounded-full bg-lime text-[12px] text-ink" aria-hidden="true">→</span>
              <p className="text-[14px] leading-[1.55]">{answer.aiFeedback}</p>
            </div>
          )}
          {answer.timeTaken > 0 && (
            <p className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-mono text-faint">
              <Clock size={12} aria-hidden="true" /> {Math.max(1, Math.round(answer.timeTaken / 60))} min on this answer
            </p>
          )}
        </div>
      )}
    </li>
  );
}

export default function SessionResultPage() {
  const { id } = useParams();
  const [openIdx, setOpenIdx] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState('');
  const { data: session, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['session', id],
    queryFn: () => sessionAPI.getById(id).then((r) => r.data.session),
    refetchInterval: (query) => query.state.data?.status === 'evaluating' ? 5000 : false,
  });

  const retryScoring = async () => {
    setRetrying(true);
    setRetryError('');
    try { await sessionAPI.complete(id); await refetch(); }
    catch (err) { setRetryError(getErrorMessage(err, 'Scoring is unavailable. Please try again.')); await refetch(); }
    finally { setRetrying(false); }
  };

  if (isLoading) return <LoadingState label="Loading your report" className="min-h-[60vh]" />;
  if (isError) {
    return (
      <ErrorState
        className="mt-6"
        title={error?.response?.status === 404 ? 'Report not found' : 'Couldn’t load this report'}
        description={getErrorMessage(error)}
        onRetry={error?.response?.status === 404 ? undefined : refetch}
      />
    );
  }

  const interview = session.interviewId || {};
  const interviewId = interview._id || session.interviewId;

  if (session.status !== 'completed') {
    const evaluating = session.status === 'evaluating';
    const stale = evaluating && (!session.evaluationStartedAt ||
      Date.now() - new Date(session.evaluationStartedAt).getTime() >= 10 * 60_000);
    return (
      <>
        <EmptyState
          className="mt-6"
          icon={Play}
          title={evaluating ? 'Scoring your answers' : 'This session isn’t scored yet'}
          description={evaluating ? 'Your answers are saved. This page updates when the report is ready.' : session.status === 'evaluation_failed'
            ? 'Scoring didn’t finish. Your answers are saved — open the session and finish again to retry.'
            : 'Finish the interview to get your per-answer report.'}
          action={evaluating ? stale ? <Button variant="lime" loading={retrying} onClick={retryScoring}>Retry scoring</Button> : null
            : <Button to={`/interviews/${interviewId}/session`} variant="lime" icon={Play}>Open session</Button>}
        />
        {retryError && <p role="alert" className="mt-4 text-center text-[14px] text-coral">{retryError}</p>}
      </>
    );
  }

  const score = Math.round(session.overallScore ?? 0);
  const v = verdict(score);
  const answers = session.answers || [];
  const categoryOf = (a) => interview.questions?.find((q) => String(q._id) === String(a.questionId))?.category || 'other';
  const answered = answers.filter((a) => !a.skipped && a.answerText).length;
  const skipped = answers.filter((a) => a.skipped).length;
  const minutes = Math.max(1, Math.round((session.totalTimeTaken || 0) / 60));

  const byCategory = Object.values(answers.reduce((acc, a) => {
    if (typeof a.aiScore !== 'number') return acc;
    const c = categoryOf(a);
    acc[c] = acc[c] || { key: c, total: 0, n: 0 };
    acc[c].total += a.aiScore;
    acc[c].n += 1;
    return acc;
  }, {})).map((c) => ({ ...c, avg: Math.round((c.total / c.n) * 10) }));

  const bars = answers.map((a, i) => ({ name: `Q${i + 1}`, score: typeof a.aiScore === 'number' ? a.aiScore : 0 }));

  return (
    <div className="space-y-6 animate-fade-in">
      <Link to="/sessions" className="mono-label inline-flex items-center gap-1.5 text-muted hover:text-ink">
        <ArrowLeft size={13} aria-hidden="true" /> History
      </Link>

      {/* Score hero */}
      <section className="relative overflow-hidden rounded-r28 bg-report p-3 sm:p-4">
        <div className="grid gap-3 rounded-r24 bg-white p-6 shadow-float sm:p-8 lg:grid-cols-[auto_1fr] lg:items-center lg:gap-10">
          <div>
            <p className="mono-label text-muted">Practice score</p>
            <p className="mt-2 flex items-baseline gap-2">
              <span className="text-[88px] font-medium leading-none tracking-display tabular">{score}</span>
              <span className="text-[20px] text-muted">/100</span>
            </p>
          </div>
          <div className="min-w-0">
            <p className="text-[28px] font-medium leading-tight tracking-tight2">{v.label}</p>
            <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-muted-strong">{v.note}</p>
            <p className="mt-4 text-[14px] text-muted">
              {[interview.jobTitle, interview.company, formatDate(session.completedAt || session.updatedAt)].filter(Boolean).join(' · ')}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <span className="pill pill-blue">{answered} answered</span>
              {skipped > 0 && <span className="pill pill-coral">{skipped} skipped</span>}
              <span className="pill pill-stone">~{minutes} min</span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 px-2 pb-1 pt-4">
          <p className="font-mono text-[11px] uppercase tracking-mono text-[#1F4C80]">Scores are practice feedback — never a hiring prediction</p>
          <div className="flex flex-wrap gap-2">
            <Button to={`/interviews/${interviewId}/session`} variant="ink" icon={RotateCcw}>Practice again</Button>
            <Button to="/interviews/new" variant="lime" icon={Plus}>New interview</Button>
          </div>
        </div>
      </section>

      {/* What worked / what to fix / next try */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Card className="p-6">
          <p className="mono-label text-lime-ok">Convincing</p>
          {session.strengths?.length ? (
            <ul className="mt-4 space-y-3">
              {session.strengths.map((s, i) => (
                <li key={i} className="flex gap-2.5 text-[14.5px] leading-relaxed">
                  <span className="mt-0.5 grid h-5 w-5 flex-shrink-0 place-items-center rounded-full bg-lime text-[10px]" aria-hidden="true">✓</span>{s}
                </li>
              ))}
            </ul>
          ) : <p className="mt-4 text-[14px] text-muted">No specific strengths were noted this time.</p>}
        </Card>
        <Card className="p-6">
          <p className="mono-label text-coral">Lacked evidence</p>
          {session.areasForImprovement?.length ? (
            <ul className="mt-4 space-y-3">
              {session.areasForImprovement.map((s, i) => (
                <li key={i} className="flex gap-2.5 text-[14.5px] leading-relaxed">
                  <span className="mt-0.5 grid h-5 w-5 flex-shrink-0 place-items-center rounded-full bg-coral-bg text-[10px] text-coral" aria-hidden="true">!</span>{s}
                </li>
              ))}
            </ul>
          ) : <p className="mt-4 text-[14px] text-muted">Nothing flagged — keep practising.</p>}
        </Card>
        <Card tone="ink" className="p-6">
          <p className="mono-label text-lime">Next try</p>
          {session.recommendedResources?.length ? (
            <ul className="mt-4 space-y-3">
              {session.recommendedResources.map((s, i) => (
                <li key={i} className="flex gap-2.5 text-[14.5px] leading-relaxed">
                  <span className="mt-0.5 grid h-5 w-5 flex-shrink-0 place-items-center rounded-full bg-lime text-[11px] text-ink" aria-hidden="true">→</span>{s}
                </li>
              ))}
            </ul>
          ) : <p className="mt-4 text-[14px] text-on-dark">{session.overallFeedback || 'Retry your lowest-scoring answers with a concrete result.'}</p>}
        </Card>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-5">
        <Card className="p-6 lg:col-span-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-[17px] font-medium tracking-tight1">Score per question</h2>
            <span className="mono-label text-muted">Out of 10</span>
          </div>
          <div className="mt-5 h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={bars} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} vertical={false} />
                <XAxis dataKey="name" {...CHART.axisProps} />
                <YAxis domain={[0, 10]} {...CHART.axisProps} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: '#F1F2F0' }} />
                <Bar dataKey="score" name="Score" radius={[6, 6, 6, 6]} maxBarSize={36}>
                  {bars.map((b, i) => <Cell key={i} fill={b.score >= 7 ? CHART.blue : b.score >= 4 ? CHART.blueSoft : CHART.coral} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card className="p-6 lg:col-span-2">
          <h2 className="text-[17px] font-medium tracking-tight1">By question type</h2>
          {byCategory.length === 0 ? (
            <p className="mt-4 text-[14px] text-muted">No scored answers to break down.</p>
          ) : (
            <div className="mt-6 space-y-5">
              {byCategory.map((c) => (
                <div key={c.key}>
                  <div className="mb-2 flex justify-between text-[13.5px]">
                    <span>{CATEGORY_LABEL[c.key] || c.key}</span>
                    <span className={c.avg >= 70 ? 'text-brand-600' : c.avg >= 40 ? 'text-muted' : 'text-coral'}>
                      {c.avg}% · {c.avg >= 70 ? 'strong' : c.avg >= 40 ? 'steady' : 'needs work'}
                    </span>
                  </div>
                  <ProgressBar value={c.avg} tone={c.avg >= 70 ? 'blue' : c.avg >= 40 ? 'soft' : 'coral'} label={`${CATEGORY_LABEL[c.key]} average`} />
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Per-answer report */}
      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-[22px] font-medium tracking-tight2">Answer by answer</h2>
          <span className="mono-label text-muted">{answers.length} questions</span>
        </div>
        {answers.length === 0 ? (
          <EmptyState compact title="No answers were recorded" description="Answers you save during the session appear here with feedback." />
        ) : (
          <ol className="space-y-2">
            {answers.map((a, i) => (
              <AnswerReview
                key={String(a.questionId) + i}
                answer={a}
                index={i}
                category={categoryOf(a)}
                open={openIdx === i}
                onToggle={() => setOpenIdx(openIdx === i ? null : i)}
              />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
