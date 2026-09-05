export async function organizer<T = any>(path: string, body?: unknown, method = body ? 'POST' : 'GET'): Promise<T> {
  const response = await fetch(`/api/organizer${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok)
    throw new Error(
      response.status === 503 ? 'Organizer worker is not configured.' : `Organizer request failed (${response.status})`,
    );
  return response.json();
}
