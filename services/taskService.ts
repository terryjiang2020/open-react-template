export interface TaskStep {
  stepOrder: number;
  stepType: number;
  stepContent: string;
  stepJsonContent?: Object;
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
  originalQuery?: string;
  planResponse?: string;
}

export interface SavedTask extends TaskPayload {
  id: number;
  taskName: string;
  taskType: number;
  taskContent: string;
  createdAt: string;
  steps?: TaskStep[];
}

export interface PlanStep {
  step_number?: number;
  description?: string;
  api?: string;
  parameters?: Record<string, any>;
  requestBody?: Record<string, any>;
  depends_on_step?: number;
}

export interface PlanSummary {
  goal?: string;
  phase?: string;
  steps?: PlanStep[];
  selected_apis?: any[];
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  awaitingApproval?: boolean;
  sessionId?: string;
  planSummary?: PlanSummary;
  planResponse?: string;
  refinedQuery?: string;
  planningDurationMs?: number;
  usedReferencePlan?: boolean;
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

  // Log saved task to file (server-side only)
  if (typeof window === 'undefined') {
    try {
      const path = require('path');
      const fs = require('fs').promises;
      const logPath = path.join(process.cwd(), '.temp', 'tasks_fetched.txt');
      
      // Ensure .temp directory exists
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      
      const timestamp = new Date().toISOString();
      const logContent = `\n=== Task Saved at ${timestamp} ===\n` +
        `Task Name: ${payload.taskName}\n` +
        `Original Query: ${payload.originalQuery || 'N/A'}\n` +
        `Task Type: ${payload.taskType}\n\n` +
        `Full Payload:\n` +
        JSON.stringify(payload, null, 2) + '\n';
      
      await fs.appendFile(logPath, logContent);
    } catch (err) {
      console.error('Failed to log saved task to file:', err);
    }
  }
}
