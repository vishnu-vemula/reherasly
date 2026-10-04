import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle, ArrowLeft, ArrowRight, Check, Lightbulb, Mic, MicOff, RotateCw, SkipForward,
  Sparkles, Volume2, VolumeX, Wand2, MessageSquareText,
} from 'lucide-react';
import { io } from 'socket.io-client';
import toast from 'react-hot-toast';
import { interviewAPI, sessionAPI } from '@/services/api';
import { SOCKET_URL } from '@/lib/axios';
import { getFirebaseToken } from '@/lib/firebase';
import { BILLING_ME_KEY } from '@/hooks/use-billing';
import { Alert, Button, Card, ErrorState, LoadingState, Pill, Spinner } from '@/components/ui';
import { cn, formatDuration, getErrorMessage } from '@/utils';

const AUTO_READ_KEY = 'rehearsly-auto-read';
const CATEGORY_LABEL = { technical: 'Technical', behavioral: 'Behavioral', situational: 'Situational', hr: 'HR', culture_fit: 'Culture fit' };

/* ── Generate-questions state (interview exists but has no questions yet) ── */
function GenerateState({ interview, onGenerated }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(Date.now());
  const queryClient = useQueryClient();
  const generating = interview.generationStatus === 'generating';
  const stale = generating && (!interview.generationStartedAt ||
    now - new Date(interview.generationStartedAt).getTime() >= 10 * 60_000);

  useEffect(() => {
    if (!generating) return undefined;
    let active = true;
    let checking = false;
    const timer = setInterval(async () => {
      if (checking) return;
      checking = true;
      setNow(Date.now());
      try {
        const { data } = await interviewAPI.getById(interview._id);
        if (active && data.interview.generationStatus !== 'generating') await onGenerated();
      } catch { /* Status checks resume on the next interval. */ }
      finally { checking = false; }
    }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [generating, interview._id, onGenerated]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await interviewAPI.generateQuestions(interview._id);
      queryClient.invalidateQueries({ queryKey: BILLING_ME_KEY });
      queryClient.invalidateQueries({ queryKey: ['interviews'] });
      await onGenerated();
    } catch (err) {
      setError({ message: getErrorMessage(err, 'Question generation failed. Please retry.'), status: err.response?.status });
      await onGenerated();
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl py-10 text-center">
      <span className="mx-auto grid h-14 w-14 place-items-center rounded-r18 bg-lime">
        {busy ? <Spinner size={22} /> : <Wand2 size={22} aria-hidden="true" />}
      </span>
      <p className="mono-label mt-6 text-muted">{interview.jobTitle}</p>
      <h1 className="mt-3 text-[34px] font-medium leading-tight tracking-tight2">
        {busy ? 'Writing your questions…' : interview.generationStatus === 'generating' ? 'Question generation is in progress' : interview.generationStatus === 'failed' ? 'Generation didn’t finish' : 'Questions not generated yet'}
      </h1>
      <p className="mt-3 text-[15.5px] leading-relaxed text-muted-strong">
        {busy
          ? 'We’re mapping the job description to your experience. This usually takes 5–20 seconds.'
          : interview.generationStatus === 'generating'
            ? 'Generation is running. This page checks for your questions automatically; an interrupted attempt can be retried after 10 minutes.'
            : 'Generate the questions for this interview to start practising. Generating uses one interview from your allowance.'}
      </p>
      {error && (
        <Alert tone="error" icon={AlertCircle} className="mt-6 text-left" title={error.status === 402 ? 'Interview allowance used up' : 'That didn’t work'}>
          {error.message} {error.status === 402 && <Link to="/pricing" className="link">Choose a pass</Link>}
        </Alert>
      )}
      <div className="mt-8 flex flex-wrap justify-center gap-2">
        <Button to="/interviews" variant="ghost" icon={ArrowLeft}>Back to interviews</Button>
        <Button variant="lime" icon={error || generating ? RotateCw : Sparkles} loading={busy} disabled={generating && !stale} onClick={run}>
          {generating && !stale ? 'Generating…' : error || generating ? 'Try again' : 'Generate questions'}
        </Button>
      </div>
    </div>
  );
}

export default function InterviewSessionPage() {
  const { id: interviewId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [interview, setInterview] = useState(null);
  const [session, setSession] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [loading, setLoading] = useState(true);

  const [currentIdx, setCurrentIdx] = useState(0);
  const [answerText, setAnswerText] = useState('');
  const [savedAnswers, setSavedAnswers] = useState({}); // questionId -> { answerText, skipped }
  const drafts = useRef({}); // questionId -> unsaved text
  const [submitting, setSubmitting] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState(null);
  const [startTime, setStartTime] = useState(Date.now());
  const [elapsed, setElapsed] = useState(0);

  // Live follow-ups (socket.io)
  const socketRef = useRef(null);
  const followupFor = useRef(null); // question id the in-flight follow-up belongs to
  const [socketStatus, setSocketStatus] = useState('connecting'); // connecting | live | offline
  const [liveFeedback, setLiveFeedback] = useState('');
  const [isReceivingFeedback, setIsReceivingFeedback] = useState(false);

  // Voice
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [autoRead, setAutoRead] = useState(() => {
    try { return localStorage.getItem(AUTO_READ_KEY) !== 'false'; } catch { return true; }
  });

  const questions = interview?.questions || [];
  const currentQuestion = questions[currentIdx];
  const totalQuestions = questions.length;

  // ── Load interview + start/resume session ──────────────────────
  const init = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const { data: intData } = await interviewAPI.getById(interviewId);
      const iv = intData.interview;
      setInterview(iv);
      if (!iv.questions?.length) return; // show the generate state
      const { data: sessData } = await sessionAPI.start(interviewId);
      const s = sessData.session;
      if (s.status === 'evaluating') {
        navigate(`/sessions/${s._id}/results`, { replace: true });
        return;
      }
      setSession(s);
      // Restore saved answers when resuming, and jump to the first unanswered question.
      const restored = {};
      (s.answers || []).forEach((a) => {
        restored[String(a.questionId)] = { answerText: a.answerText || '', skipped: !!a.skipped, followupUsed: !!a.followupUsed };
      });
      setSavedAnswers(restored);
      if (sessData.resumed) {
        const firstOpen = iv.questions.findIndex((q) => !restored[q._id]);
        const idx = firstOpen === -1 ? iv.questions.length - 1 : firstOpen;
        setCurrentIdx(idx);
        setAnswerText(restored[iv.questions[idx]._id]?.answerText || '');
        const n = Object.keys(restored).length;
        if (n) toast.success(`Welcome back — ${n} answer${n === 1 ? '' : 's'} restored`, { id: `restored-${s._id}` });
      }
      setStartTime(Date.now());
    } catch (err) {
      setLoadError({ message: getErrorMessage(err, 'Couldn’t start this session.'), status: err.response?.status });
    } finally {
      setLoading(false);
    }
  }, [interviewId, navigate]);

  useEffect(() => { init(); }, [init]);

  // ── Socket connection ──────────────────────────────────────────
  useEffect(() => {
    const s = io(SOCKET_URL, {
      auth: (callback) => { getFirebaseToken().then((token) => callback({ token })).catch(() => callback({ token: null })); },
      reconnectionAttempts: 5,
      transports: ['websocket', 'polling'],
    });
    socketRef.current = s;
    s.on('connect', () => setSocketStatus('live'));
    s.on('disconnect', () => { setSocketStatus('offline'); setIsReceivingFeedback(false); });
    s.on('connect_error', () => { setSocketStatus('offline'); setIsReceivingFeedback(false); });
    s.on('ai_chunk', (chunk) => setLiveFeedback((prev) => prev + chunk));
    s.on('ai_complete', () => {
      setIsReceivingFeedback(false);
      const qid = followupFor.current;
      if (qid) setSavedAnswers((prev) => ({ ...prev, [qid]: { ...prev[qid], followupUsed: true } }));
    });
    s.on('ai_error', (msg) => {
      setIsReceivingFeedback(false);
      toast.error(typeof msg === 'string' ? msg : 'Live follow-up is unavailable right now.');
    });
    return () => { s.disconnect(); };
  }, []);

  // ── Speech synthesis ───────────────────────────────────────────
  const speak = useCallback((text) => {
    if (!window.speechSynthesis || !text) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    u.onend = () => setIsSpeaking(false);
    u.onerror = () => setIsSpeaking(false);
    window.speechSynthesis.speak(u);
    setIsSpeaking(true);
  }, []);

  const toggleSpeakQuestion = () => {
    if (!window.speechSynthesis) return toast.error('Reading aloud isn’t supported in this browser.');
    if (isSpeaking) { window.speechSynthesis.cancel(); setIsSpeaking(false); } else speak(currentQuestion?.questionText);
  };

  useEffect(() => {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setIsSpeaking(false);
    if (!autoRead || !currentQuestion?.questionText) return undefined;
    const t = setTimeout(() => speak(currentQuestion.questionText), 500);
    return () => clearTimeout(t);
  }, [currentIdx, currentQuestion?.questionText, autoRead, speak]);

  useEffect(() => () => { window.speechSynthesis?.cancel(); }, []);

  const toggleAutoRead = () => {
    setAutoRead((v) => {
      try { localStorage.setItem(AUTO_READ_KEY, String(!v)); } catch { /* ignore */ }
      if (v) window.speechSynthesis?.cancel();
      return !v;
    });
  };

  // ── Speech recognition (voice answers) ─────────────────────────
  useEffect(() => {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) return undefined;
    const rec = new SpeechRec();
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let finalText = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
      }
      // Only final results are appended (interim results would repeat words).
      if (finalText) {
        setAnswerText((prev) => {
          const trimmed = prev.trimEnd();
          return trimmed + (trimmed ? ' ' : '') + finalText.trim();
        });
      }
    };
    rec.onerror = (e) => {
      setIsListening(false);
      if (e.error !== 'aborted' && e.error !== 'no-speech') toast.error('Microphone access was blocked or failed.');
    };
    rec.onend = () => setIsListening(false);
    recognitionRef.current = rec;
    return () => { try { rec.abort(); } catch { /* ignore */ } };
  }, []);

  const toggleListening = () => {
    const rec = recognitionRef.current;
    if (!rec) return toast.error('Voice answers aren’t supported in this browser — try Chrome or Edge.');
    if (isListening) { rec.stop(); setIsListening(false); } else {
      try { rec.start(); setIsListening(true); } catch { /* already started */ }
    }
  };

  useEffect(() => {
    if (isListening) { recognitionRef.current?.stop(); setIsListening(false); }
  }, [currentIdx]);

  // ── Timer ──────────────────────────────────────────────────────
  useEffect(() => {
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startTime) / 1000)), 1000);
    return () => clearInterval(t);
  }, [startTime]);

  // ── Answers ────────────────────────────────────────────────────
  const saveAnswer = useCallback(async (skipped = false) => {
    if (!session || !currentQuestion) return false;
    const text = answerText.trim();
    if (!text && !skipped) {
      if (savedAnswers[currentQuestion._id]) return true;
      toast.error('Write an answer or choose Skip question.');
      return false;
    }
    setSubmitting(true);
    try {
      const { data } = await sessionAPI.submitAnswer(session._id, {
        questionId: currentQuestion._id,
        answerText: skipped ? '' : text,
        timeTaken: Math.floor((Date.now() - startTime) / 1000),
        skipped,
      });
      const saved = data.session?.answers?.find((answer) => answer.questionId === currentQuestion._id);
      setSavedAnswers((prev) => ({ ...prev,
        [currentQuestion._id]: { answerText: saved?.answerText ?? (skipped ? '' : text),
          skipped: saved?.skipped ?? skipped, followupUsed: !!saved?.followupUsed },
      }));
      delete drafts.current[currentQuestion._id];
      return true;
    } catch (err) {
      toast.error(getErrorMessage(err, 'Couldn’t save your answer — check your connection and try again.'));
      return false;
    } finally {
      setSubmitting(false);
    }
  }, [session, currentQuestion, answerText, startTime, savedAnswers]);

  const goTo = (idx) => {
    if (isReceivingFeedback || idx < 0 || idx >= totalQuestions || idx === currentIdx) return;
    if (currentQuestion) drafts.current[currentQuestion._id] = answerText;
    const target = questions[idx];
    setAnswerText(drafts.current[target._id] ?? savedAnswers[target._id]?.answerText ?? '');
    setCurrentIdx(idx);
    setStartTime(Date.now());
    setElapsed(0);
    setLiveFeedback('');
    setIsReceivingFeedback(false);
  };

  const handleNext = async (skip = false) => {
    const ok = await saveAnswer(skip);
    if (ok) goTo(currentIdx + 1);
  };

  const skipLastQuestion = async () => {
    if (await saveAnswer(true)) setAnswerText('');
  };

  const navigateToQuestion = async (idx) => {
    if (isReceivingFeedback) return;
    if (idx > currentIdx && !await saveAnswer(false)) return;
    goTo(idx);
  };

  const handleComplete = async () => {
    if (isReceivingFeedback) return;
    const ok = await saveAnswer(false);
    if (!ok) return;
    const answeredIds = new Set(Object.keys(savedAnswers));
    if (answerText.trim() && currentQuestion) answeredIds.add(currentQuestion._id);
    const firstUnanswered = questions.findIndex((q) => !answeredIds.has(q._id));
    if (firstUnanswered >= 0) {
      toast.error('Answer or skip every question before finishing.');
      goTo(firstUnanswered);
      return;
    }
    setCompleting(true);
    setCompleteError(null);
    try {
      await sessionAPI.complete(session._id);
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      queryClient.invalidateQueries({ queryKey: ['interviews'] });
      toast.success('Your report is ready');
      navigate(`/sessions/${session._id}/results`);
    } catch (err) {
      setCompleteError(getErrorMessage(err, 'Scoring didn’t finish. Your answers are saved — try again.'));
      setCompleting(false);
    }
  };

  // The server grants one live follow-up per saved answer, so save the answer first.
  const handleLiveAIFeedback = async () => {
    const text = answerText.trim();
    if (!text) return toast.error('Type or say part of your answer first.');
    if (socketStatus !== 'live') return toast.error('Live follow-ups are offline right now.');
    const saved = await saveAnswer(false);
    if (!saved) return;
    followupFor.current = currentQuestion._id;
    setLiveFeedback('');
    setIsReceivingFeedback(true);
    socketRef.current?.emit('live_answer', { sessionId: session._id, interviewId, questionId: currentQuestion._id, answerText: text });
  };

  const answeredCount = useMemo(() => Object.values(savedAnswers).filter((a) => !a.skipped && a.answerText).length, [savedAnswers]);

  // ── Render states ──────────────────────────────────────────────
  if (loading) return <LoadingState label="Setting up your session" className="min-h-[60vh]" />;

  if (loadError) {
    return (
      <ErrorState
        className="mt-6"
        title={loadError.status === 404 ? 'Interview not found' : 'Couldn’t start this session'}
        description={loadError.message}
        onRetry={loadError.status === 404 ? undefined : init}
      />
    );
  }

  if (interview && !questions.length) return <GenerateState interview={interview} onGenerated={init} />;
  if (!interview || !session || !currentQuestion) return null;

  const isLast = currentIdx === totalQuestions - 1;
  const saved = savedAnswers[currentQuestion._id];

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <Link to="/interviews" className="mono-label inline-flex items-center gap-1.5 text-muted hover:text-ink">
            <ArrowLeft size={13} aria-hidden="true" /> Interviews
          </Link>
          <h1 className="mt-3 truncate text-[30px] font-medium leading-tight tracking-tight2 sm:text-[36px]">{interview.jobTitle}</h1>
          <p className="mt-1 text-[14px] capitalize text-muted">
            {[interview.company, `${interview.experienceLevel} level`, `${totalQuestions} questions`].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-white px-3.5 py-2 font-mono text-[12px] tabular" aria-label="Time on this question">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" aria-hidden="true" />
            {formatDuration(elapsed)}
          </span>
          <span className="rounded-full bg-ink px-3.5 py-2 font-mono text-[12px] text-white tabular">{currentIdx + 1} / {totalQuestions}</span>
        </div>
      </div>

      {/* Segmented progress */}
      <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${totalQuestions}, minmax(0, 1fr))` }} aria-hidden="true">
        {questions.map((q, i) => {
          const a = savedAnswers[q._id];
          return (
            <div
              key={q._id}
              className={cn('h-[5px] rounded-full transition-colors', i === currentIdx ? 'bg-ink' : a?.skipped ? 'bg-coral-bar' : a ? 'bg-brand' : 'bg-stone')}
            />
          );
        })}
      </div>

      {session.status === 'evaluation_failed' && (
        <Alert tone="warn" icon={AlertCircle} title="Scoring didn’t finish last time">
          Your answers are saved. Review them if you like, then choose “Finish & get report” to score again.
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-3">
          {/* Question (ink card from the design) */}
          <section key={currentIdx} className="animate-slide-up rounded-r24 bg-ink p-6 text-white sm:p-8" aria-live="polite">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.06em] text-lime">
                <span className="h-1.5 w-1.5 rounded-full bg-lime" aria-hidden="true" />
                Question {currentIdx + 1} of {totalQuestions}
              </div>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={toggleAutoRead}
                  aria-pressed={autoRead}
                  title={autoRead ? 'Auto-read is on' : 'Auto-read is off'}
                  className={cn('rounded-full px-3 py-1.5 font-mono text-[10px] uppercase tracking-mono transition-colors', autoRead ? 'bg-white/15 text-white' : 'text-on-dark hover:bg-white/10')}
                >
                  Auto-read {autoRead ? 'on' : 'off'}
                </button>
                <button
                  type="button"
                  onClick={toggleSpeakQuestion}
                  aria-label={isSpeaking ? 'Stop reading the question' : 'Read the question aloud'}
                  className={cn('grid h-8 w-8 place-items-center rounded-full transition-colors', isSpeaking ? 'bg-lime text-ink' : 'bg-white/10 text-white hover:bg-white/20')}
                >
                  {isSpeaking ? <VolumeX size={15} /> : <Volume2 size={15} />}
                </button>
              </div>
            </div>
            <p className="mt-5 text-[22px] leading-[1.3] tracking-[-0.015em] sm:text-[26px]">“{currentQuestion.questionText}”</p>
            <div className="mt-6 flex flex-wrap gap-1.5">
              {currentQuestion.category && <span className="rounded-full bg-white/10 px-3 py-1.5 text-[12px]">{CATEGORY_LABEL[currentQuestion.category] || currentQuestion.category}</span>}
              {currentQuestion.difficulty && <span className="rounded-full bg-white/10 px-3 py-1.5 text-[12px] capitalize">{currentQuestion.difficulty}</span>}
              {interview.usedResume && <span className="rounded-full bg-white/10 px-3 py-1.5 text-[12px]">From your resume</span>}
              {saved && (
                <span className="inline-flex items-center gap-1 rounded-full bg-lime px-3 py-1.5 text-[12px] text-ink">
                  <Check size={12} aria-hidden="true" /> {saved.skipped ? 'Skipped' : 'Saved'}
                </span>
              )}
            </div>
          </section>

          {/* Answer */}
          <Card className="p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label htmlFor="answer" className="text-[15px] font-medium">Your answer</label>
              <Button
                size="sm"
                variant={isListening ? 'danger' : 'soft'}
                icon={isListening ? MicOff : Mic}
                onClick={toggleListening}
                aria-pressed={isListening}
              >
                {isListening ? 'Stop voice' : 'Answer by voice'}
              </Button>
            </div>

            {isListening && (
              <div className="mt-3 flex items-center gap-3 rounded-r14 bg-blue-card px-4 py-3 text-white" role="status">
                <div className="flex h-6 items-center gap-[3px]" aria-hidden="true">
                  {[10, 18, 24, 14, 20, 12, 22, 9].map((h, i) => (
                    <span key={i} className="w-[3px] animate-wave rounded-sm bg-white" style={{ height: h, animationDelay: `${i * 0.1}s` }} />
                  ))}
                </div>
                <span className="font-mono text-[11px] uppercase tracking-mono">Listening… speak your answer</span>
              </div>
            )}

            <textarea
              id="answer"
              className={cn('field mt-3 min-h-[200px] leading-relaxed', isListening && 'border-brand shadow-ring')}
              placeholder="Type your answer, or answer by voice. For behavioral questions, cover the situation, your task, the actions you took and a measurable result."
              value={answerText}
              onChange={(e) => setAnswerText(e.target.value)}
              maxLength={4000}
            />
            <div className="mt-2 flex items-center justify-between text-[12.5px] text-muted">
              <span className="tabular">{answerText.length}/4000</span>
              {answerText.trim() && saved && answerText.trim() !== saved.answerText && <span>Unsaved changes</span>}
            </div>

            {currentQuestion.expectedKeywords?.length > 0 && (
              <div className="mt-4 rounded-r14 bg-paper p-4">
                <p className="mono-label flex items-center gap-1.5 text-muted"><Lightbulb size={13} aria-hidden="true" /> Cover these if they apply</p>
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {currentQuestion.expectedKeywords.map((k) => <Pill key={k} tone="outline">{k}</Pill>)}
                </div>
              </div>
            )}

            {completeError && (
              <Alert tone="error" icon={AlertCircle} className="mt-4" title="Scoring didn’t finish">
                {completeError}
              </Alert>
            )}

            <div className="mt-6 flex flex-col-reverse gap-2 border-t border-line-2 pt-5 sm:flex-row sm:items-center sm:justify-between">
              <Button variant="ghost" icon={ArrowLeft} onClick={() => goTo(currentIdx - 1)} disabled={currentIdx === 0 || submitting || completing || isReceivingFeedback}>
                Previous
              </Button>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button variant="soft" icon={SkipForward} onClick={() => isLast ? skipLastQuestion() : handleNext(true)} disabled={submitting || completing || isReceivingFeedback}>
                  Skip question
                </Button>
                {isLast ? (
                  <Button variant="lime" cta onClick={handleComplete} loading={completing} disabled={submitting || isReceivingFeedback} className="py-[6px]">
                    {completing ? 'Scoring your answers…' : completeError ? 'Retry scoring' : 'Finish & get report'}
                  </Button>
                ) : (
                  <Button variant="ink" iconRight={ArrowRight} onClick={() => handleNext(false)} loading={submitting} disabled={!answerText.trim() || isReceivingFeedback}>
                    Save & next
                  </Button>
                )}
              </div>
            </div>
          </Card>
        </div>

        {/* Side panel */}
        <aside className="space-y-3">
          <Card className="p-5">
            <div className="flex items-center justify-between">
              <p className="mono-label text-muted">Live follow-up</p>
              <span className={cn('inline-flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-mono', socketStatus === 'live' ? 'text-lime-ok' : socketStatus === 'connecting' ? 'text-muted' : 'text-coral')}>
                <span className={cn('h-1.5 w-1.5 rounded-full', socketStatus === 'live' ? 'bg-lime-ok' : socketStatus === 'connecting' ? 'bg-faint' : 'bg-coral')} />
                {socketStatus === 'live' ? 'Connected' : socketStatus === 'connecting' ? 'Connecting' : 'Offline'}
              </span>
            </div>
            <p className="mt-2 text-[13.5px] leading-relaxed text-muted">Ask the interviewer to push on your answer, the way a real one would — one follow-up per answer.</p>
            <Button
              variant="outline"
              size="sm"
              icon={MessageSquareText}
              className="mt-4 w-full"
              onClick={handleLiveAIFeedback}
              loading={isReceivingFeedback || (submitting && !completing)}
              disabled={!answerText.trim() || socketStatus !== 'live' || !!saved?.followupUsed}
            >
              {isReceivingFeedback ? 'Listening to you…' : saved?.followupUsed ? 'Follow-up used' : 'Save & get a follow-up'}
            </Button>
            {saved?.followupUsed && !liveFeedback && (
              <p className="mt-2 text-[12.5px] text-muted">You’ve had this answer’s live follow-up. Use it to strengthen your answer before moving on.</p>
            )}
            {(liveFeedback || isReceivingFeedback) && (
              <div className="mt-4 rounded-r14 bg-ink p-4 text-[14px] leading-relaxed text-white" aria-live="polite">
                <p className="mono-label mb-2 text-lime">Interviewer</p>
                {liveFeedback}
                {isReceivingFeedback && <span className="ml-1 inline-block h-3.5 w-1.5 animate-pulse bg-lime align-middle" />}
              </div>
            )}
          </Card>

          <Card className="p-5">
            <div className="flex items-center justify-between">
              <p className="mono-label text-muted">Questions</p>
              <span className="font-mono text-[11px] text-muted tabular">{answeredCount} answered</span>
            </div>
            <ol className="mt-3 grid grid-cols-5 gap-1.5 lg:grid-cols-4">
              {questions.map((q, i) => {
                const a = savedAnswers[q._id];
                return (
                  <li key={q._id}>
                    <button
                      type="button"
                      onClick={() => navigateToQuestion(i)}
                      disabled={submitting || completing || isReceivingFeedback}
                      aria-label={`Question ${i + 1}${a ? (a.skipped ? ', skipped' : ', answered') : ''}`}
                      aria-current={i === currentIdx ? 'step' : undefined}
                      className={cn(
                        'grid h-10 w-full place-items-center rounded-r14 font-mono text-[12px] transition-colors',
                        i === currentIdx ? 'bg-ink text-white' : a?.skipped ? 'bg-coral-bg text-coral' : a ? 'bg-brand-50 text-brand-600' : 'bg-stone-2 text-muted hover:bg-stone',
                      )}
                    >
                      {a && !a.skipped && i !== currentIdx ? <Check size={14} /> : i + 1}
                    </button>
                  </li>
                );
              })}
            </ol>
            <p className="mt-4 text-[12.5px] leading-relaxed text-muted">
              Answers save as you go. Leave any time — you’ll resume right here.
            </p>
          </Card>
        </aside>
      </div>
    </div>
  );
}
