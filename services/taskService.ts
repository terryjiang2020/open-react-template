export interface TaskStep {
  stepOrder: number;
  stepType: number;
  stepContent: string;
}

export interface TaskPayload {
  taskName: string;
  taskType: number;
  taskContent: string;
  taskSteps: TaskStep[];
}

export async function saveTask(payload: TaskPayload, token: string): Promise<void> {
  const baseUrl = process.env.NEXT_PUBLIC_ELASTICDASH_API || '';
  const url = `${baseUrl}/task`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || 'Failed to save task');
  }
}
