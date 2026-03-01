const BASE_URL = process.env.AGENTIC_API_BASE_URL ?? 'http://localhost:7070';

async function request(path) {
  const response = await fetch(`${BASE_URL}${path}`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`API ${response.status}: ${path}`);
  }
  return response.json();
}

export async function listTasks() {
  const data = await request('/tasks');
  return data.tasks ?? [];
}

export async function readTask(id) {
  return request(`/tasks/${encodeURIComponent(id)}`);
}

export async function listAttempts(id) {
  const data = await request(`/tasks/${encodeURIComponent(id)}/attempts`);
  return data.attempts ?? [];
}

export async function listEvents(id) {
  const data = await request(`/tasks/${encodeURIComponent(id)}/events?limit=5000`);
  return data.events ?? [];
}
