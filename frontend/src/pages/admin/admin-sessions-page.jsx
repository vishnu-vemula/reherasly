/**
 * AdminSessionsPage — every mock-interview practice session across the platform
 * (GET /admin/sessions), paginated, with super-admin delete (DELETE /admin/sessions/:id).
 */

import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { MessageSquare, RefreshCw, Trash2 } from 'lucide-react';
import { getAdminSessions, deleteAdminSession } from '@/services/admin.service';
import { useAdminAuth } from '@/context';
import {
  Avatar, Button, EmptyState, ErrorState, PageHeader, Pagination, Pill, ScorePill, Skeleton, TableShell, useConfirm,
} from '@/components/ui';
import { cn, formatDate, getErrorMessage, timeAgo } from '@/utils';

const PAGE_SIZE = 15;

const STATUS = {
  started: { tone: 'blue', label: 'Started' },
  in_progress: { tone: 'blue', label: 'In progress' },
  evaluating: { tone: 'stone', label: 'Evaluating' },
  evaluation_failed: { tone: 'coral', label: 'Evaluation failed' },
  completed: { tone: 'ok', label: 'Completed' },
  abandoned: { tone: 'stone', label: 'Abandoned' },
};

export default function AdminSessionsPage() {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const { isSuperAdmin } = useAdminAuth();
  const [page, setPage] = useState(1);
  const [deletingId, setDeletingId] = useState(null);

  const { data, isLoading, isFetching, isPlaceholderData, isError, error, refetch } = useQuery({
    queryKey: ['admin-sessions', { page, limit: PAGE_SIZE }],
    queryFn: () => getAdminSessions({ page, limit: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  const sessions = data?.sessions ?? [];
  const total = data?.total ?? 0;
  const totalPages = data?.pages ?? 0;

  // After a delete empties the last page, step back.
  useEffect(() => {
    if (data && data.pages > 0 && page > data.pages) setPage(data.pages);
  }, [data, page]);

  const handleDelete = async (s) => {
    const who = s.userId?.name ? ` by ${s.userId.name}` : '';
    const what = s.interviewId?.jobTitle ? ` for “${s.interviewId.jobTitle}”` : '';
    const ok = await confirm({
      title: 'Delete this session?',
      description: `The practice session${what}${who} and all of its answers and feedback will be permanently deleted. This can’t be undone.`,
      confirmLabel: 'Delete session',
      tone: 'danger',
    });
    if (!ok) return;
    setDeletingId(s._id);
    try {
      await deleteAdminSession(s._id);
      toast.success('Session deleted.');
      queryClient.invalidateQueries({ queryKey: ['admin-sessions'] });
    } catch (err) {
      toast.error(getErrorMessage(err, 'Couldn’t delete this session.'));
    } finally {
      setDeletingId(null);
    }
  };

  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Admin · Sessions"
        title="Practice sessions"
        description={
          isLoading || total === 0
            ? 'Every mock interview session across all candidates, newest first.'
            : `${total} mock interview ${total === 1 ? 'session' : 'sessions'} across all candidates, newest first.`
        }
        actions={
          <Button variant="soft" icon={RefreshCw} onClick={() => refetch()} loading={isFetching && !isLoading}>
            Refresh
          </Button>
        }
      />

      {isError ? (
        <ErrorState
          title="Couldn’t load sessions"
          description={getErrorMessage(error, 'The sessions service did not respond.')}
          onRetry={refetch}
        />
      ) : !isLoading && sessions.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title="No practice sessions yet"
          description="Sessions appear here once candidates start a mock interview."
        />
      ) : (
        <div className="space-y-5">
          <TableShell minWidth={900} className={cn(isFetching && isPlaceholderData && 'opacity-60 transition-opacity')}>
            <thead>
              <tr>
                <th>Interview</th>
                <th>Candidate</th>
                <th>Status</th>
                <th>Score</th>
                <th>Answers</th>
                <th>Date</th>
                {isSuperAdmin && <th className="text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {isLoading
                ? Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    <td>
                      <div className="space-y-1.5">
                        <Skeleton className="h-3.5 w-40" />
                        <Skeleton className="h-3 w-24" />
                      </div>
                    </td>
                    <td>
                      <div className="space-y-1.5">
                        <Skeleton className="h-3.5 w-28" />
                        <Skeleton className="h-3 w-40" />
                      </div>
                    </td>
                    <td><Skeleton className="h-6 w-24 rounded-full" /></td>
                    <td><Skeleton className="h-6 w-12 rounded-full" /></td>
                    <td><Skeleton className="h-4 w-8" /></td>
                    <td><Skeleton className="h-4 w-24" /></td>
                    {isSuperAdmin && <td><Skeleton className="ml-auto h-8 w-8 rounded-full" /></td>}
                  </tr>
                ))
                : sessions.map((s) => {
                  const st = STATUS[s.status] || { tone: 'stone', label: s.status || 'Unknown' };
                  return (
                    <tr key={s._id}>
                      <td>
                        <p className={cn('max-w-[240px] truncate font-medium', !s.interviewId && 'text-muted')}>
                          {s.interviewId?.jobTitle ?? 'Deleted interview'}
                        </p>
                        {s.interviewId?.company && (
                          <p className="max-w-[240px] truncate text-[12.5px] text-muted">{s.interviewId.company}</p>
                        )}
                      </td>
                      <td>
                        {s.userId ? (
                          <div className="flex items-center gap-2.5">
                            <Avatar name={s.userId.name} size={28} tone="stone" />
                            <div className="min-w-0">
                              <p className="max-w-[200px] truncate text-[13.5px]">{s.userId.name ?? '—'}</p>
                              <p className="max-w-[200px] truncate text-[12.5px] text-muted">{s.userId.email ?? ''}</p>
                            </div>
                          </div>
                        ) : (
                          <span className="text-[13px] text-muted">Deleted account</span>
                        )}
                      </td>
                      <td><Pill tone={st.tone} mono>{st.label}</Pill></td>
                      <td><ScorePill score={s.overallScore} /></td>
                      <td className="tabular">{s.answerCount ?? 0}</td>
                      <td className="whitespace-nowrap">
                        <p className="whitespace-nowrap text-[13px]">{formatDate(s.createdAt)}</p>
                        <p className="whitespace-nowrap text-[12px] text-muted">{timeAgo(s.createdAt)}</p>
                      </td>
                      {isSuperAdmin && (
                        <td>
                          <div className="flex justify-end">
                            <Button
                              variant="ghost"
                              size="sm"
                              iconOnly
                              icon={Trash2}
                              title="Delete session"
                              aria-label="Delete session"
                              loading={deletingId === s._id}
                              className="hover:bg-coral-soft hover:text-coral"
                              onClick={() => handleDelete(s)}
                            />
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
            </tbody>
          </TableShell>

          {!isLoading && totalPages > 1 && (
            <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
              <p className="mono-label text-muted tabular">Showing {from}–{to} of {total}</p>
              <Pagination page={page} totalPages={totalPages} onPageChange={setPage} disabled={isFetching} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
