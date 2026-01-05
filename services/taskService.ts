export interface TaskStep {
  stepOrder: number;
  stepType: number;
  stepContent: string;
  api?: {
    path: string;
    method: string;
    parameters?: Record<string, any>;
    requestBody?: Record<string, any>;
  };
  depends_on_step?: number;
}

export interface TaskPayload {
  taskName: string;
  taskType: number;
  taskContent: string;
  taskSteps: TaskStep[];
}

export interface SavedTask extends TaskPayload {
  id: number;
  taskName: string;
  taskType: number;
  taskContent: string;
  createdAt: string;
  steps?: TaskStep[];
}

export async function fetchTaskList(token: string): Promise<SavedTask[]> {
  const baseUrl = process.env.NEXT_PUBLIC_ELASTICDASH_API || '';
  const url = `${baseUrl}/task/list`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || 'Failed to fetch task list');
  }

  const data = await res.json();
  if (Array.isArray(data?.result)) return data.result as SavedTask[];
  if (Array.isArray(data)) return data as SavedTask[];
  return [];
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
