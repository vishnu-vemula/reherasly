import { useCallback, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle, ChevronDown, Download, FileText, RefreshCw, Star, Trash2, Upload,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { resumeAPI } from '@/services/api';
import {
  Alert, Button, Card, EmptyState, ErrorState, Field, Modal, PageHeader, Pill, ProgressBar, SkeletonList, Textarea, useConfirm,
} from '@/components/ui';
import { cn, formatDate, getErrorMessage } from '@/utils';

const MAX_BYTES = 5 * 1024 * 1024;
const PARSE_STATUS = {
  pending: { label: 'Processing', tone: 'blue' },
  parsed: { label: 'Text extracted', tone: 'ok' },
  failed: { label: 'Extraction failed', tone: 'coral' },
};

function Section({ title, children }) {
  return (
    <div>
      <p className="mono-label mb-2 text-muted">{title}</p>
      {children}
    </div>
  );
}

function ParsedData({ resume, onReparse }) {
  const d = resume.parsedData;
  if (!d) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-r18 bg-paper p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[14px] text-muted">We haven’t structured this resume yet.</p>
        <Button size="sm" variant="outline" icon={RefreshCw} onClick={onReparse} disabled={!resume.extractedText && resume.parseStatus !== 'parsed'}>
          Parse now
        </Button>
      </div>
    );
  }
  const skills = Array.isArray(d.skills) ? d.skills : [];
  const experience = Array.isArray(d.experience) ? d.experience : [];
  const projects = Array.isArray(d.projects) ? d.projects : [];
  const required = Array.isArray(d.required_skills) ? d.required_skills : [];

  return (
    <div className="space-y-5">
      {d.name && <p className="text-[18px] font-medium tracking-tight1">{d.name}</p>}
      {skills.length > 0 && (
        <Section title={`Skills · ${skills.length}`}>
          <div className="flex flex-wrap gap-1.5">{skills.map((s, i) => <Pill key={i} tone="blue">{s}</Pill>)}</div>
        </Section>
      )}
      {experience.length > 0 && (
        <Section title="Experience">
          <div className="grid gap-2 sm:grid-cols-2">
            {experience.map((e, i) => (
              <div key={i} className="rounded-r14 bg-paper p-3.5 text-[13.5px]">
                <p className="font-medium">{e.role}{e.company && <span className="font-normal text-muted"> · {e.company}</span>}</p>
                {e.duration && <p className="mt-0.5 text-muted">{e.duration}</p>}
                {Array.isArray(e.tech) && e.tech.length > 0 && <p className="mt-1.5 text-[12.5px] text-muted-strong">{e.tech.join(' · ')}</p>}
              </div>
            ))}
          </div>
        </Section>
      )}
      {projects.length > 0 && (
        <Section title="Projects">
          <div className="grid gap-2 sm:grid-cols-2">
            {projects.map((p, i) => (
              <div key={i} className="rounded-r14 bg-paper p-3.5 text-[13.5px]">
                <p className="font-medium">{p.title}</p>
                {p.description && <p className="mt-1 leading-relaxed text-muted-strong">{p.description}</p>}
                {Array.isArray(p['tech stack']) && p['tech stack'].length > 0 && <p className="mt-1.5 text-[12.5px] text-muted">{p['tech stack'].join(' · ')}</p>}
              </div>
            ))}
          </div>
        </Section>
      )}
      {d.education && (
        <Section title="Education">
          <p className="text-[14px] text-ink-soft">{typeof d.education === 'string' ? d.education : Array.isArray(d.education) ? d.education.map((x) => (typeof x === 'string' ? x : Object.values(x).filter(Boolean).join(', '))).join(' · ') : Object.values(d.education).filter(Boolean).join(', ')}</p>
        </Section>
      )}
      {(d.role || required.length > 0) && (
        <Section title="Matched job description">
          {d.role && <p className="mb-2 text-[14px] font-medium">{d.role}</p>}
          {required.length > 0 && <div className="flex flex-wrap gap-1.5">{required.map((s, i) => <Pill key={i} tone="lime">{s}</Pill>)}</div>}
        </Section>
      )}
      <Button size="sm" variant="ghost" icon={RefreshCw} onClick={onReparse} className="-ml-2">
        Re-parse with a job description
      </Button>
    </div>
  );
}

export default function ResumesPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [upload, setUpload] = useState(null); // { name, progress, phase: 'uploading'|'analysing' }
  const [uploadError, setUploadError] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [reparse, setReparse] = useState(null); // resume being re-parsed
  const [jdInput, setJdInput] = useState('');
  const [parsing, setParsing] = useState(false);

  const { data: resumes = [], isLoading, isError, error, refetch } = useQuery({
    queryKey: ['resumes'],
    queryFn: () => resumeAPI.getAll().then((r) => r.data.resumes || []),
  });
  const setResumes = (updater) => queryClient.setQueryData(['resumes'], (old = []) => updater(old));

  const onDrop = useCallback(async (accepted, rejected) => {
    setUploadError('');
    if (rejected?.length) {
      const code = rejected[0].errors?.[0]?.code;
      setUploadError(code === 'file-too-large' ? 'That file is over 5 MB. Export a smaller PDF and try again.' : code === 'file-invalid-type' ? 'Only PDF resumes are supported.' : 'Upload one PDF file at a time.');
      return;
    }
    const file = accepted[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('resume', file);
    setUpload({ name: file.name, progress: 0, phase: 'uploading' });
    try {
      const { data } = await resumeAPI.upload(formData, (e) => {
        const pct = e.total ? Math.round((e.loaded / e.total) * 100) : 0;
        setUpload({ name: file.name, progress: pct, phase: pct >= 100 ? 'analysing' : 'uploading' });
      });
      setResumes((prev) => [data.resume, ...prev.map((r) => (data.resume.isDefault ? { ...r, isDefault: false } : r))]);
      setExpanded(data.resume._id);
      toast.success(`“${file.name}” uploaded`);
    } catch (err) {
      setUploadError(getErrorMessage(err, 'Upload failed. Please try again.'));
    } finally {
      setUpload(null);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    accept: { 'application/pdf': ['.pdf'] },
    maxFiles: 1,
    maxSize: MAX_BYTES,
    multiple: false,
    disabled: !!upload,
    noClick: true,
  });

  const handleDelete = async (resume) => {
    const ok = await confirm({
      title: 'Delete this resume?',
      description: `“${resume.originalName}” will be permanently removed from storage. Interviews with generated questions keep them. Generate any pending interview questions first.`,
      confirmLabel: 'Delete resume',
      tone: 'danger',
    });
    if (!ok) return;
    setBusyId(resume._id);
    try {
      await resumeAPI.delete(resume._id);
      setResumes((prev) => prev.filter((r) => r._id !== resume._id));
      toast.success('Resume deleted');
    } catch (err) {
      toast.error(getErrorMessage(err, 'Couldn’t delete the resume'));
    } finally {
      setBusyId(null);
    }
  };

  const handleDownload = async (resume) => {
    setBusyId(resume._id);
    try {
      const { data } = await resumeAPI.download(resume._id);
      const link = document.createElement('a');
      link.href = data.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err) {
      toast.error(getErrorMessage(err, 'Download is unavailable right now'));
    } finally {
      setBusyId(null);
    }
  };

  const handleSetDefault = async (resume) => {
    setBusyId(resume._id);
    try {
      await resumeAPI.setDefault(resume._id);
      setResumes((prev) => prev.map((r) => ({ ...r, isDefault: r._id === resume._id })));
      toast.success('Default resume updated');
    } catch (err) {
      toast.error(getErrorMessage(err, 'Couldn’t update the default resume'));
    } finally {
      setBusyId(null);
    }
  };

  const handleReparse = async () => {
    if (!reparse) return;
    setParsing(true);
    try {
      const { data } = await resumeAPI.parse(reparse._id, jdInput.trim());
      setResumes((prev) => prev.map((r) => (r._id === reparse._id ? { ...r, parsedData: data.parsedData, isParsed: true, parseStatus: 'parsed' } : r)));
      toast.success('Resume parsed');
      setExpanded(reparse._id);
      setReparse(null);
      setJdInput('');
    } catch (err) {
      toast.error(getErrorMessage(err, 'Parsing failed. Please try again.'));
    } finally {
      setParsing(false);
    }
  };

  return (
    <div className="space-y-8 animate-fade-in">
      <PageHeader
        eyebrow="Prepare"
        title="Resumes"
        description="Add a resume to tailor interview questions to your experience. Files are stored privately — only you can download them."
      />

      {/* Dropzone */}
      <div
        {...getRootProps()}
        className={cn(
          'relative overflow-hidden rounded-r28 border-2 border-dashed p-8 text-center transition-colors sm:p-10',
          isDragActive ? 'border-brand bg-brand-50' : 'border-line bg-white hover:border-ink/40',
          upload && 'pointer-events-none',
        )}
      >
        <input {...getInputProps()} aria-label="Upload resume PDF" />
        {upload ? (
          <div className="mx-auto max-w-sm" role="status">
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-r14 bg-lime"><Upload size={20} aria-hidden="true" /></span>
            <p className="mt-4 truncate text-[16px] font-medium">{upload.name}</p>
            <p className="mono-label mt-1 text-muted">{upload.phase === 'uploading' ? `Uploading · ${upload.progress}%` : 'Extracting text & skills…'}</p>
            <ProgressBar className="mt-4" value={upload.phase === 'uploading' ? upload.progress : 100} tone={upload.phase === 'uploading' ? 'blue' : 'lime'} label="Upload progress" />
          </div>
        ) : (
          <>
            <span className={cn('mx-auto grid h-12 w-12 place-items-center rounded-r14', isDragActive ? 'bg-brand text-white' : 'bg-stone')}>
              <Upload size={20} aria-hidden="true" />
            </span>
            <p className="mt-4 text-[20px] font-medium tracking-tight1">{isDragActive ? 'Drop your resume' : 'Drag your resume here'}</p>
            <p className="mt-1 text-[14px] text-muted">PDF only · up to 5 MB</p>
            <Button variant="ink" className="mt-5" icon={Upload} onClick={open}>Choose a PDF</Button>
          </>
        )}
      </div>

      {uploadError && <Alert tone="error" icon={AlertCircle} title="Upload didn’t work">{uploadError}</Alert>}

      {/* List */}
      {isLoading ? (
        <SkeletonList rows={2} />
      ) : isError ? (
        <ErrorState title="Couldn’t load your resumes" description={getErrorMessage(error)} onRetry={refetch} />
      ) : resumes.length === 0 ? (
        <EmptyState compact icon={FileText} title="No resumes yet" description="Upload a PDF above — we’ll extract your skills and experience so questions fit you." />
      ) : (
        <section>
          <p className="mono-label mb-3 text-muted">{resumes.length} resume{resumes.length === 1 ? '' : 's'}</p>
          <ul className="space-y-3">
            {resumes.map((resume) => {
              const ps = PARSE_STATUS[resume.parseStatus] || PARSE_STATUS.pending;
              const isOpen = expanded === resume._id;
              const busy = busyId === resume._id;
              return (
                <li key={resume._id}>
                  <Card className="p-5">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 items-start gap-4">
                        <span className={cn('grid h-11 w-11 flex-shrink-0 place-items-center rounded-r14', resume.isDefault ? 'bg-lime' : 'bg-stone-2')}>
                          <FileText size={18} aria-hidden="true" />
                        </span>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-[16px] font-medium">{resume.originalName}</p>
                            {resume.isDefault && <Pill tone="lime" mono icon={Star}>Default</Pill>}
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
                            <Pill tone={ps.tone}>{ps.label}</Pill>
                            {resume.isParsed && <Pill tone="blue">AI structured</Pill>}
                            {resume.fileSize ? <span>{Math.max(1, Math.round(resume.fileSize / 1024))} KB</span> : null}
                            <span>{formatDate(resume.createdAt)}</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5 self-end sm:self-auto">
                        <Button size="sm" variant="soft" icon={Download} onClick={() => handleDownload(resume)} disabled={busy}>Download</Button>
                        {!resume.isDefault && (
                          <Button size="sm" variant="soft" icon={Star} onClick={() => handleSetDefault(resume)} disabled={busy}>Make default</Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          iconOnly
                          icon={Trash2}
                          aria-label={`Delete ${resume.originalName}`}
                          onClick={() => handleDelete(resume)}
                          loading={busy}
                          className="hover:bg-coral-soft hover:text-coral"
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          iconOnly
                          icon={ChevronDown}
                          aria-label={isOpen ? 'Hide details' : 'Show extracted details'}
                          aria-expanded={isOpen}
                          onClick={() => setExpanded(isOpen ? null : resume._id)}
                          className={cn('transition-transform', isOpen && 'rotate-180')}
                        />
                      </div>
                    </div>
                    {isOpen && (
                      <div className="mt-5 border-t border-line-2 pt-5 animate-fade-in">
                        {resume.parseStatus === 'failed' ? (
                          <Alert tone="warn" icon={AlertCircle} title="We couldn’t read text from this PDF">
                            It may be a scanned image. Export a text-based PDF from your editor and upload it again.
                          </Alert>
                        ) : (
                          <ParsedData resume={resume} onReparse={() => { setReparse(resume); setJdInput(''); }} />
                        )}
                      </div>
                    )}
                  </Card>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <Modal
        open={!!reparse}
        onClose={() => !parsing && setReparse(null)}
        title="Re-parse resume"
        description="Optionally paste a job description to match required skills and responsibilities."
        footer={
          <>
            <Button variant="ghost" onClick={() => setReparse(null)} disabled={parsing}>Cancel</Button>
            <Button variant="ink" icon={RefreshCw} loading={parsing} onClick={handleReparse}>Parse</Button>
          </>
        }
      >
        <Field label="Job description" hint="Optional">
          <Textarea rows={7} value={jdInput} onChange={(e) => setJdInput(e.target.value)} placeholder="Paste a job description…" />
        </Field>
      </Modal>
    </div>
  );
}
