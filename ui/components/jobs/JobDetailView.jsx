'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';

function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function elapsedForTask(task) {
  const started = Date.parse(task?.created_at ?? '');
  if (!started) return '-';
  const terminal = task?.status === 'done' || task?.status === 'failed' || task?.status === 'blocked';
  const endTs = terminal ? Date.parse(task?.updated_at ?? '') || Date.now() : Date.now();
  return formatElapsed(endTs - started);
}

function elapsedForAttempt(attempt) {
  const started = Date.parse(attempt?.started_at ?? '');
  if (!started) return '-';
  const finished = attempt?.finished_at ? Date.parse(attempt.finished_at) : Date.now();
  return formatElapsed((finished || Date.now()) - started);
}

function configuredMode(task) {
  return task?.task_request?.mode ?? 'auto';
}

function effectiveMode(attempts, fallback = 'unknown') {
  const latest = attempts?.[attempts.length - 1];
  if (!latest?.output_json) return fallback;
  try {
    const parsed = JSON.parse(latest.output_json);
    return parsed?.mode?.effective ?? fallback;
  } catch {
    return fallback;
  }
}

function statusBadgeClass(status) {
  if (status === 'done') return 'bg-emerald-100 text-emerald-800 border-emerald-200';
  if (status === 'running' || status === 'leased') return 'bg-blue-100 text-blue-800 border-blue-200';
  if (status === 'queued') return 'bg-amber-100 text-amber-900 border-amber-200';
  if (status === 'failed' || status === 'blocked') return 'bg-rose-100 text-rose-900 border-rose-200';
  return 'bg-slate-100 text-slate-700 border-slate-200';
}

function levelBadgeClass(level) {
  if (level === 'error') return 'bg-rose-100 text-rose-900 border-rose-200';
  if (level === 'warn') return 'bg-amber-100 text-amber-900 border-amber-200';
  return 'bg-slate-100 text-slate-700 border-slate-200';
}

function parseEventPayload(event) {
  try {
    const parsed = JSON.parse(event.data_json);
    const envelope = parsed?.envelope;
    const streamType = envelope?.type;
    const producer = envelope?.producer;
    const payload = envelope?.payload && typeof envelope.payload === 'object'
      ? envelope.payload
      : parsed;
    const eventName = typeof payload?.event_name === 'string' ? payload.event_name : null;
    const displayMessage = typeof payload?.message === 'string' ? payload.message : event.message;
    return {
      parsed,
      payload,
      streamType: typeof streamType === 'string' ? streamType : 'event',
      producer: producer === 'model' ? 'model' : 'system',
      eventName,
      displayMessage
    };
  } catch {
    return {
      parsed: { raw: event.data_json },
      payload: { raw: event.data_json },
      streamType: 'event',
      producer: 'system',
      eventName: null,
      displayMessage: event.message
    };
  }
}

function shortText(value, max = 220) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}...`;
}

function formatInlineValue(value, max = 800) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return shortText(value, max);
  try {
    return shortText(JSON.stringify(value, null, 2), max);
  } catch {
    return shortText(String(value), max);
  }
}

function parseModelOutputMessage(raw) {
  const obj = (() => {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw;
    }
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        return null;
      }
      return null;
    }
    return null;
  })();

  if (!obj) {
    return { type: null, subtype: null, preview: typeof raw === 'string' ? shortText(raw, 180) : null };
  }

  const type = typeof obj.type === 'string' ? obj.type : null;
  const subtype = typeof obj.subtype === 'string' ? obj.subtype : null;
  let preview = null;

  const assistantText = obj?.message?.content?.find?.((entry) => entry?.type === 'text')?.text;
  if (typeof assistantText === 'string') {
    preview = shortText(assistantText, 180);
  }
  if (!preview && typeof obj.result === 'string') {
    preview = shortText(obj.result, 180);
  }
  return { type, subtype, preview };
}

function buildHighlights(event, parsedPayload, streamType) {
  const lines = [];
  let prompt = null;

  if (streamType === 'state_change') {
    if (parsedPayload?.from || parsedPayload?.to) {
      lines.push(`state: ${parsedPayload?.from ?? '?'} -> ${parsedPayload?.to ?? '?'}`);
    }
    return { lines, prompt };
  }

  if (event.phase === 'mode') {
    if (parsedPayload?.configured_mode || parsedPayload?.effective_mode) {
      lines.push(`mode: ${parsedPayload?.configured_mode ?? 'auto'} -> ${parsedPayload?.effective_mode ?? 'auto'}`);
    }
  }

  if (streamType === 'action') {
    if (parsedPayload?.tool) lines.push(`tool: ${parsedPayload.tool}`);
    if (parsedPayload?.step_id) lines.push(`step: ${parsedPayload.step_id}`);
    if (parsedPayload?.arguments?.prompt && typeof parsedPayload.arguments.prompt === 'string') {
      prompt = parsedPayload.arguments.prompt;
    }
    return { lines, prompt };
  }

  if (streamType === 'tool_result') {
    if (parsedPayload?.tool) lines.push(`tool: ${parsedPayload.tool}`);
    if (typeof parsedPayload?.ok === 'boolean') lines.push(`ok: ${parsedPayload.ok ? 'true' : 'false'}`);
    const summary = parsedPayload?.result?.summary;
    if (typeof summary === 'string') lines.push(`summary: ${shortText(summary, 180)}`);
    return { lines, prompt };
  }

  if (streamType === 'artifact') {
    if (parsedPayload?.name) lines.push(`artifact: ${parsedPayload.name}`);
    if (parsedPayload?.format) lines.push(`format: ${parsedPayload.format}`);
    const summary = parsedPayload?.content?.summary;
    if (typeof summary === 'string') lines.push(`summary: ${shortText(summary, 180)}`);
    return { lines, prompt };
  }

  if (streamType === 'model_output') {
    const type = typeof parsedPayload?.model_event_type === 'string'
      ? parsedPayload.model_event_type
      : null;
    const subtype = typeof parsedPayload?.model_event_subtype === 'string'
      ? parsedPayload.model_event_subtype
      : null;
    const body = typeof parsedPayload?.message_body === 'string'
      ? parsedPayload.message_body
      : null;
    const parsedModel = parseModelOutputMessage(parsedPayload?.message);

    if (type || parsedModel?.type) {
      const effectiveType = type ?? parsedModel?.type;
      const effectiveSubtype = subtype ?? parsedModel?.subtype;
      lines.push(`model event: ${effectiveType}${effectiveSubtype ? `/${effectiveSubtype}` : ''}`);
    }
    if (body) {
      lines.push(`preview: ${shortText(body, 180)}`);
    } else if (parsedModel?.preview) {
      lines.push(`preview: ${parsedModel.preview}`);
    }
    return { lines, prompt };
  }

  if (streamType === 'event') {
    if (typeof parsedPayload?.message === 'string') lines.push(`detail: ${parsedPayload.message}`);
    const effective = parsedPayload?.data?.effective_mode ?? parsedPayload?.effective_mode;
    const configured = parsedPayload?.data?.configured_mode ?? parsedPayload?.configured_mode;
    if (configured || effective) lines.push(`mode: ${configured ?? 'auto'} -> ${effective ?? 'auto'}`);
    if (parsedPayload?.data?.llm_prompt && typeof parsedPayload.data.llm_prompt === 'string') {
      prompt = parsedPayload.data.llm_prompt;
    } else if (parsedPayload?.llm_prompt && typeof parsedPayload.llm_prompt === 'string') {
      prompt = parsedPayload.llm_prompt;
    }
    const outputSummary = parsedPayload?.data?.output?.summary ?? parsedPayload?.output?.summary;
    if (typeof outputSummary === 'string') lines.push(`summary: ${shortText(outputSummary, 180)}`);
  }

  return { lines, prompt };
}

function EventRow({ event }) {
  const [open, setOpen] = useState(false);
  const [showFullPrompt, setShowFullPrompt] = useState(false);
  const { parsed, payload, streamType, producer, eventName, displayMessage } = parseEventPayload(event);
  const { lines, prompt } = buildHighlights(event, payload, streamType);
  const promptPreview = prompt ? shortText(prompt, 360) : null;
  const modelBody = streamType === 'model_output' ? formatInlineValue(payload?.message_body, 700) : null;

  return (
    <div className="relative pl-8">
      <div className="absolute left-0 top-2 h-3 w-3 rounded-sm bg-slate-500" />
      <div
        className="rounded-xl border bg-card p-3 transition hover:bg-muted/40"
        role="button"
        tabIndex={0}
        onClick={() => setOpen((x) => !x)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((x) => !x);
          }
        }}
      >
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-semibold">{event.phase}</span>
          <Badge variant="outline" className={levelBadgeClass(event.level)}>{event.level}</Badge>
          <Badge variant="outline" className="bg-indigo-100 text-indigo-800 border-indigo-200">{streamType}</Badge>
          <Badge variant="outline" className={producer === 'model' ? 'bg-fuchsia-100 text-fuchsia-800 border-fuchsia-200' : 'bg-slate-100 text-slate-700 border-slate-200'}>
            {producer}
          </Badge>
          {eventName ? <Badge variant="outline" className="bg-cyan-100 text-cyan-800 border-cyan-200">{eventName}</Badge> : null}
          <span>{event.created_at}</span>
          <span>#{event.id}</span>
          {event.attempt_id ? <span>attempt:{event.attempt_id}</span> : null}
        </div>
        <p className="mt-2 text-sm font-semibold">{displayMessage}</p>
        {lines.length > 0 ? (
          <div className="mt-2 space-y-1">
            {lines.map((line, idx) => (
              <p key={`${event.id}-hl-${idx}`} className="text-xs text-muted-foreground">{line}</p>
            ))}
          </div>
        ) : null}
        {streamType === 'model_output' ? (
          <div className="mt-2 space-y-2 rounded-md border bg-muted/40 p-2">
            {modelBody ? (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Body</p>
                <pre className="whitespace-pre-wrap break-words text-xs">{modelBody}</pre>
              </div>
            ) : null}
          </div>
        ) : null}
        {promptPreview ? (
          <div className="mt-2 rounded-md border bg-muted/40 p-2">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Prompt</p>
            <pre className="whitespace-pre-wrap break-words text-xs">{showFullPrompt ? prompt : promptPreview}</pre>
            {prompt.length > promptPreview.length ? (
              <button
                type="button"
                className="mt-2 text-xs font-medium text-blue-700 hover:underline"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setShowFullPrompt((v) => !v);
                }}
              >
                {showFullPrompt ? 'Show less' : 'Show full prompt'}
              </button>
            ) : null}
          </div>
        ) : null}
        {open ? (
          <pre className="mt-3 overflow-x-auto rounded-lg bg-muted/50 p-3 text-xs">
            {JSON.stringify(parsed, null, 2)}
          </pre>
        ) : null}
      </div>
    </div>
  );
}

export default function JobDetailView({ task, attempts, events }) {
  const [phaseFilter, setPhaseFilter] = useState('all');
  const [levelFilter, setLevelFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [attemptFilter, setAttemptFilter] = useState('all');
  const [query, setQuery] = useState('');

  const phaseOptions = useMemo(() => ['all', ...new Set(events.map((e) => e.phase))], [events]);
  const levelOptions = useMemo(() => ['all', ...new Set(events.map((e) => e.level))], [events]);
  const typeOptions = useMemo(() => {
    const values = events.map((e) => parseEventPayload(e).streamType);
    return ['all', ...new Set(values)];
  }, [events]);

  const filteredEvents = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...events]
      .sort((a, b) => (Date.parse(a.created_at ?? '') || 0) - (Date.parse(b.created_at ?? '') || 0))
      .filter((event) => {
        if (phaseFilter !== 'all' && event.phase !== phaseFilter) return false;
        if (levelFilter !== 'all' && event.level !== levelFilter) return false;
        if (attemptFilter !== 'all' && String(event.attempt_id ?? 'none') !== attemptFilter) return false;
        const parsed = parseEventPayload(event);
        if (typeFilter !== 'all' && parsed.streamType !== typeFilter) return false;
        if (!q) return true;
        const blob = `${parsed.displayMessage}\n${parsed.eventName ?? ''}\n${event.phase}\n${event.level}\n${event.data_json}`.toLowerCase();
        return blob.includes(q);
      });
  }, [events, phaseFilter, levelFilter, typeFilter, attemptFilter, query]);

  return (
    <main className="ds-shell">
      <header className="mb-6 flex items-center justify-between gap-3">
        <div>
          <p className="ds-label">Job Detail</p>
          <h1 className="text-2xl font-bold tracking-tight">{task?.title ?? 'Task'}</h1>
          <p className="font-mono text-xs text-muted-foreground">{task?.id}</p>
        </div>
        <Button asChild variant="outline">
          <Link href="/">Back</Link>
        </Button>
      </header>

      <div className="grid gap-5 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Job</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p><span className="grid-label">Status:</span> <span className="ml-2"><Badge variant="outline" className={statusBadgeClass(task.status)}>{task.status}</Badge></span></p>
            <p><span className="grid-label">Mode:</span> <span className="ml-2">{configuredMode(task)} / {effectiveMode(attempts, configuredMode(task))}</span></p>
            <p><span className="grid-label">Type:</span> <span className="ml-2">{task.type}</span></p>
            <p><span className="grid-label">Attempts:</span> <span className="ml-2">{task.attempt_count}/{task.max_attempts}</span></p>
            <p><span className="grid-label">Elapsed:</span> <span className="ml-2">{elapsedForTask(task)}</span></p>
            <p><span className="grid-label">Updated:</span> <span className="ml-2 text-muted-foreground">{task.updated_at}</span></p>
            {task.last_error ? (
              <p className="text-rose-700"><span className="grid-label">Error:</span> <span className="ml-2">{task.last_error}</span></p>
            ) : null}
            <Separator />
            <div>
              <p className="grid-label">Prompt</p>
              <p className="mt-1 whitespace-pre-wrap text-sm">{task.prompt}</p>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base">Attempts</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-2">
              {attempts.map((attempt) => (
                <div key={attempt.id} className="rounded-xl border bg-muted/40 p-3">
                  <p className="text-xs text-muted-foreground">#{attempt.attempt_no} · {attempt.status}</p>
                  <p className="mt-1 text-xs text-muted-foreground">phase: {attempt.phase}</p>
                  <p className="mt-1 text-xs text-muted-foreground">started: {attempt.started_at}</p>
                  <p className="mt-1 text-xs text-muted-foreground">finished: {attempt.finished_at ?? '-'}</p>
                  <p className="mt-1 text-xs text-muted-foreground">elapsed: {elapsedForAttempt(attempt)}</p>
                </div>
              ))}
              {attempts.length === 0 ? <p className="text-sm text-muted-foreground">No attempts yet.</p> : null}
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-5">
          <CardHeader className="pb-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="text-base">Execution Timeline</CardTitle>
              <p className="text-xs text-muted-foreground">{filteredEvents.length} / {events.length} events</p>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 md:grid-cols-6">
              <Input
                className="md:col-span-2"
                placeholder="Search event text..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <Select value={phaseFilter} onValueChange={setPhaseFilter}>
                <SelectTrigger><SelectValue placeholder="Phase" /></SelectTrigger>
                <SelectContent>
                  {phaseOptions.map((v) => <SelectItem key={v} value={v}>{v === 'all' ? 'All phases' : v}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger><SelectValue placeholder="Type" /></SelectTrigger>
                <SelectContent>
                  {typeOptions.map((v) => <SelectItem key={v} value={v}>{v === 'all' ? 'All types' : v}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={levelFilter} onValueChange={setLevelFilter}>
                <SelectTrigger><SelectValue placeholder="Level" /></SelectTrigger>
                <SelectContent>
                  {levelOptions.map((v) => <SelectItem key={v} value={v}>{v === 'all' ? 'All levels' : v}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={attemptFilter} onValueChange={setAttemptFilter}>
                <SelectTrigger><SelectValue placeholder="Attempt" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All attempts</SelectItem>
                  <SelectItem value="none">No attempt</SelectItem>
                  {attempts.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      attempt {a.attempt_no} (id:{a.id})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="relative space-y-3 pl-2">
              <div className="timeline-rail absolute left-[13px] top-2 bottom-2" />
              {filteredEvents.map((event) => <EventRow key={event.id} event={event} />)}
              {filteredEvents.length === 0 ? <p className="text-sm text-muted-foreground">No events match current filters.</p> : null}
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
