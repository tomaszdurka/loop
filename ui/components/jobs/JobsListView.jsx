'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

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
  const started = Date.parse(task.created_at ?? '');
  if (!started) return '-';
  const terminal = task.status === 'done' || task.status === 'failed' || task.status === 'blocked';
  const endTs = terminal ? Date.parse(task.updated_at ?? '') || Date.now() : Date.now();
  return formatElapsed(endTs - started);
}

function configuredMode(task) {
  return task?.task_request?.mode ?? 'auto';
}

function statusBadgeClass(status) {
  if (status === 'done') return 'bg-emerald-100 text-emerald-800 border-emerald-200';
  if (status === 'running' || status === 'leased') return 'bg-blue-100 text-blue-800 border-blue-200';
  if (status === 'queued') return 'bg-amber-100 text-amber-900 border-amber-200';
  if (status === 'failed' || status === 'blocked') return 'bg-rose-100 text-rose-900 border-rose-200';
  return 'bg-slate-100 text-slate-700 border-slate-200';
}

export default function JobsListView({ tasks }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [mode, setMode] = useState('all');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tasks
      .filter((task) => {
        if (status !== 'all' && task.status !== status) return false;
        if (mode !== 'all' && configuredMode(task) !== mode) return false;
        if (!q) return true;
        return (
          String(task.id).toLowerCase().includes(q)
          || String(task.title ?? '').toLowerCase().includes(q)
          || String(task.prompt ?? '').toLowerCase().includes(q)
          || String(task.type ?? '').toLowerCase().includes(q)
        );
      })
      .sort((a, b) => (Date.parse(b.created_at ?? '') || 0) - (Date.parse(a.created_at ?? '') || 0));
  }, [tasks, query, status, mode]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 pt-0 md:grid-cols-4">
          <Input
            placeholder="Search by id, title, prompt..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger>
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="queued">queued</SelectItem>
              <SelectItem value="leased">leased</SelectItem>
              <SelectItem value="running">running</SelectItem>
              <SelectItem value="done">done</SelectItem>
              <SelectItem value="failed">failed</SelectItem>
              <SelectItem value="blocked">blocked</SelectItem>
            </SelectContent>
          </Select>
          <Select value={mode} onValueChange={setMode}>
            <SelectTrigger>
              <SelectValue placeholder="Mode" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All modes</SelectItem>
              <SelectItem value="auto">auto</SelectItem>
              <SelectItem value="lean">lean</SelectItem>
              <SelectItem value="full">full</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex items-center justify-end text-xs text-muted-foreground">
            {filtered.length} jobs
          </div>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <div className="grid gap-3 border-b bg-muted/40 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.13em] text-muted-foreground lg:grid-cols-[minmax(0,3fr)_130px_90px_90px_110px_190px]">
          <span>Task</span>
          <span>Status</span>
          <span>Mode</span>
          <span>Attempts</span>
          <span>Elapsed</span>
          <span>Updated</span>
        </div>
        <ul className="divide-y">
          {filtered.map((task) => (
            <li key={task.id}>
              <Link href={`/jobs/${task.id}`} className="block px-4 py-4 transition hover:bg-muted/40">
                <div className="grid gap-3 lg:grid-cols-[minmax(0,3fr)_130px_90px_90px_110px_190px]">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{task.title || 'Untitled task'}</p>
                    <p className="mt-1 truncate text-xs text-muted-foreground">{task.prompt}</p>
                    <p className="mt-1 font-mono text-[11px] text-muted-foreground">{task.id}</p>
                  </div>
                  <div className="flex items-center">
                    <Badge variant="outline" className={statusBadgeClass(task.status)}>{task.status}</Badge>
                  </div>
                  <div className="text-xs">{configuredMode(task)}</div>
                  <div className="text-xs">{task.attempt_count}/{task.max_attempts}</div>
                  <div className="text-xs">{elapsedForTask(task)}</div>
                  <div className="text-xs text-muted-foreground">{task.updated_at}</div>
                </div>
              </Link>
            </li>
          ))}
          {filtered.length === 0 ? (
            <li className="p-10 text-center text-sm text-muted-foreground">No jobs match current filters.</li>
          ) : null}
        </ul>
      </Card>
    </div>
  );
}

