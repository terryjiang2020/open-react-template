// Validation utilities for chat API
// Handles validator logic

export async function validateNeedMoreActions(
  originalQuery: string,
  executedSteps: any[],
  accumulatedResults: any[],
  apiKey: string,
  lastExecutionPlan?: any
): Promise<{
  needsMoreActions: boolean,
  reason: string,
  missing_requirements?: string[],
  suggested_next_action?: string,
  useful_data?: string
}> {
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are the VALIDATOR.\n\nYour ONLY responsibility is to determine whether\nthe ORIGINAL USER GOAL has been fully satisfied.\n... (prompt omitted for brevity, see route.ts for full prompt) ...`,
          },
          {
            role: 'user',
            content: `Original Query: ${originalQuery}\n\nLast Execution Plan: ${lastExecutionPlan ? JSON.stringify(lastExecutionPlan.execution_plan || lastExecutionPlan, null, 2) : 'No plan available'}\n\nExecuted Steps (with responses): ${JSON.stringify(executedSteps, null, 2)}\n\nAccumulated Results: ${JSON.stringify(accumulatedResults, null, 2)}\n\nCan we answer the original query with the information we have? Or do we need more API calls?`,
          },
        ],
        temperature: 0.3,
        max_tokens: 4096,
      }),
    });
    if (!response.ok) {
      return { needsMoreActions: false, reason: 'Validator error, proceeding with available data' };
    }
    const data = await response.json();
    const content = data.choices[0]?.message?.content || '';
    const sanitized = content.replace(/```json|```/g, '').trim();
    const jsonMatch = sanitized.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { needsMoreActions: false, reason: 'Unable to parse validator response' };
  } catch (error) {
    console.error('Error in validator:', error);
    return { needsMoreActions: false, reason: 'Validator error, proceeding with available data' };
  }
}
