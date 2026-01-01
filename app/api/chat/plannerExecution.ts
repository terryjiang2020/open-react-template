// Planner execution utilities for chat API
// Handles planner input preparation and execution

export async function runPlannerWithInputs({
  topKResults,
  refinedQuery,
  apiKey,
  usefulData,
  conversationContext,
  finalDeliverable
}: {
  topKResults: any[],
  refinedQuery: string,
  apiKey: string,
  usefulData: string,
  conversationContext?: string,
  finalDeliverable?: string
}): Promise<{ actionablePlan: any, planResponse: string }> {
  const planResponse = await sendToPlanner(topKResults, refinedQuery, apiKey, usefulData, conversationContext);
  let actionablePlan;
  try {
    const sanitizedPlanResponse = sanitizePlannerResponse(planResponse);
    console.log('Sanitized Planner Response:', sanitizedPlanResponse);
    actionablePlan = JSON.parse(sanitizedPlanResponse);
    if (actionablePlan && finalDeliverable && !actionablePlan.final_deliverable) {
      actionablePlan.final_deliverable = finalDeliverable;
    }
  } catch (error) {
    console.warn('Failed to parse planner response as JSON:', error);
    console.warn('Original Planner Response:', planResponse);
    throw new Error('Failed to parse planner response');
  }
  return { actionablePlan, planResponse };
}

// Enhanced JSON sanitization to handle comments and invalid trailing characters
export function sanitizePlannerResponse(response: string): string {
  try {
    let cleaned = response.replace(/```json|```/g, '').trim();
    cleaned = cleaned.replace(/\/\/.*(?=[\n\r])/g, '');
    cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, 'null');
    cleaned = cleaned.replace(/<[^>]+>/g, 'null');
    cleaned = cleaned.replace(/,\s*null\s*,/g, ',');
    cleaned = cleaned.replace(/,\s*,/g, ',');
    cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
    cleaned = cleaned.replace(/:\s*,/g, ': null,');
    const jsonMatch = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (jsonMatch) {
      return jsonMatch[0];
    }
    throw new Error('No valid JSON found in the response.');
  } catch (error) {
    console.error('Error sanitizing planner response:', error);
    throw error;
  }
}

// Dummy implementation for sendToPlanner, should be replaced by actual logic from planner.ts
export async function sendToPlanner(
  apis: any[],
  refinedQuery: string,
  apiKey: string,
  usefulData: string,
  conversationContext?: string
): Promise<string> {
  // This should be implemented in planner.ts and imported here
  return '';
}
