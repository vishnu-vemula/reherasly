import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, History, Play } from 'lucide-react';
import { sessionAPI } from '@/services/api';
import { Button, EmptyState, ErrorState, PageHeader, Pagination, Pill, ScorePill, SkeletonList } from '@/components/ui';
import { formatDate, getErrorMessage } from '@/utils';

const STATUS = {
  started: { label: 'In progress', tone: 'blue' },
  in_progress: { label: 'In progress', tone: 'blue' },
  evaluating: { label: 'Scoring', tone: 'blue' },
  evaluation_failed: { label: 'Scoring failed', tone: 'coral' },
  completed: { label: 'Completed', tone: 'ok' },
  abandoned: { label: 'Abandoned', tone: 'stone' },
};

export default function SessionHistoryPage() {
  const [page, setPage] = useState(1);
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['sessions', { page, limit: 10 }],
    queryFn: () => sessionAPI.getAll({ page, limit: 10 }).then((r) => r.data),
    placeholderData: (prev) => prev,
  });
  const sessions = data?.sessions || [];

  return (
    <div className="space-y-8 animate-fade-in">
      <PageHeader
        eyebrow="Practice"
        title="History"
        description="Every session you’ve run, with its practice score. Open a report to see answer-by-answer feedback."
      />

      {isLoading ? (
        <SkeletonList rows={5} />
      ) : isError ? (
        <ErrorState title="Couldn’t load your history" description={getErrorMessage(error)} onRetry={refetch} />
      ) : sessions.length === 0 ? (
        <EmptyState
          icon={History}
          title="No sessions yet"
          description="Start an interview — your sessions and reports will collect here."
          action={<Button to="/interviews/new" variant="lime" icon={Play}>Start practising</Button>}
        />
      ) : (
        <ul className="space-y-2" aria-busy={isFetching}>
          {sessions.map((s) => {
            const status = STATUS[s.status] || { label: s.status, tone: 'stone' };
            const done = s.status === 'completed';
            const interviewId = s.interviewId?._id;
            const to = done || s.status === 'evaluating' ? `/sessions/${s._id}/results` : interviewId ? `/interviews/${interviewId}/session` : null;
            const body = (
              <>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-[16px] font-medium tracking-tight1">{s.interviewId?.jobTitle || 'Deleted interview'}</p>
                    <Pill tone={status.tone}>{status.label}</Pill>
                  </div>
                  <p className="mt-1 text-[13px] text-muted">
                    {[s.interviewId?.company, formatDate(s.createdAt), s.totalTimeTaken > 0 && `~${Math.ceil(s.totalTimeTaken / 60)} min`].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <div className="flex flex-shrink-0 items-center gap-3">
                  {done ? <ScorePill score={s.overallScore} /> : to && <span className="mono-label text-brand-600">{s.status === 'evaluating' ? 'View status' : 'Resume'}</span>}
                  {to && <ArrowRight size={16} className="text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink" aria-hidden="true" />}
                </div>
              </>
            );
            return (
              <li key={s._id}>
                {to ? (
                  <Link to={to} className="group card card-interactive flex items-center justify-between gap-4 p-5 hover:text-ink">{body}</Link>
                ) : (
                  <div className="card flex items-center justify-between gap-4 p-5 opacity-70">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Pagination page={page} totalPages={data?.totalPages} onPageChange={setPage} disabled={isFetching} />
    </div>
  );
}
