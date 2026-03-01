import { listAttempts, listEvents, readTask } from '../../../lib/api';
import JobDetailView from '../../../components/jobs/JobDetailView';

export const dynamic = 'force-dynamic';

export default async function JobDetailPage({ params }) {
  const { id } = await params;

  let task = null;
  let attempts = [];
  let events = [];
  let loadError = null;

  try {
    [task, attempts, events] = await Promise.all([
      readTask(id),
      listAttempts(id),
      listEvents(id)
    ]);
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }

  return (
    loadError ? (
      <main className="ds-shell">
        <section className="surface p-5 text-rose">
          <p className="font-semibold">Could not load task</p>
          <p className="mt-1 text-sm">{loadError}</p>
        </section>
      </main>
    ) : (
      <JobDetailView task={task} attempts={attempts} events={events} />
    )
  );
}
