// Validation utilities for chat API
// Handles validator logic

import fs from 'fs';
import path from 'path';
import { fetchPromptFile } from './promptUtils';

export async function validateNeedMoreActions(
  originalQuery: string,
  executedSteps: any[],
  accumulatedResults: any[],
  usefulData: Map<string, any>,
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
        Authorization: `Bearer ${process.env.NEXT_PUBLIC_OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: await fetchPromptFile('prompt-verifier.txt'),
          },
          {
            role: 'user',
            content: `Original Query: ${originalQuery}\n\nUseful Data: ${JSON.stringify(Object.fromEntries(usefulData), null, 2)}\n\nLast Execution Plan: ${lastExecutionPlan ? JSON.stringify(lastExecutionPlan.execution_plan || lastExecutionPlan, null, 2) : 'No plan available'}\n\nExecuted Steps (with responses): ${JSON.stringify(executedSteps, null, 2)}\n\nAccumulated Results: ${JSON.stringify(accumulatedResults, null, 2)}\n\nCan we answer the original query with the information we have? Or do we need more API calls?`,
          },
        ],
        temperature: 0,
        max_tokens: 4096,
      }),
    });
    if (!response.ok) {
        console.warn('Validator API response not OK:', response.status, response.statusText);
        return { needsMoreActions: false, reason: 'Validator error, proceeding with available data' };
    }
    const data = await response.json();
    const content = data.choices[0]?.message?.content || '';
    const sanitized = content.replace(/```json|```/g, '').trim();
    const jsonMatch = sanitized.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    console.log('Validator response parsing failed, content:', content);
    return { needsMoreActions: false, reason: 'Unable to parse validator response' };
  } catch (error) {
    console.error('Error in validator:', error);
    return { needsMoreActions: false, reason: 'Validator error, proceeding with available data' };
  }
}
