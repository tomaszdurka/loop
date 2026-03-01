import { listTasks } from '../lib/api';
import JobsListView from '../components/jobs/JobsListView';

export const dynamic = 'force-dynamic';

export default async function JobsPage() {
  let tasks = [];
  let loadError = null;

  try {
    tasks = await listTasks();
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }

  return (
    <main className="ds-shell">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="ds-label">Agentic Loop</p>
          <h1 className="ds-title">Jobs Dashboard</h1>
          <p className="ds-subtitle">Source: http://localhost:7070/tasks</p>
        </div>
        <a
          href="/"
          className="ds-button"
        >
          Refresh
        </a>
      </header>

      {loadError ? (
        <section className="surface p-5 text-rose">
          <p className="font-semibold">Could not load tasks</p>
          <p className="mt-1 text-sm">{loadError}</p>
        </section>
      ) : (
        <JobsListView tasks={tasks} />
      )}
    </main>
  );
}
