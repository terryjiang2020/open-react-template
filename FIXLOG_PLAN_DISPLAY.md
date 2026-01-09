# Fix: Display All Steps in Execution Plan for MODIFY Intents

## Issue
When users requested to perform a modification task (like "Remove Metapod from my watchlist"), the execution plan display only showed the final modification step (DELETE) instead of showing all steps including prerequisite resolution steps (like fetching the Pokemon ID).

**Example:**
- Expected: Shows both "Step 1: Fetch Metapod ID (SQL query)" and "Step 2: Delete from watchlist (DELETE API)"
- Actual: Only showed "Step 2: Delete from watchlist" with the plan display showing `undefined` for phase and partial step information

## Root Cause
In the file `app/api/chat/route.ts` at lines 548-559, the function `runPlannerWithInputs` had logic to handle cases where a MODIFY intent initially returns a resolution-only plan (just the first step). 

When re-planning to get the complete execution plan, the code was calling:
```typescript
const tablePlanResponse = await sendToPlanner(refinedQuery, apiKey, usefulData, conversationContext, 'FETCH', true);
```

**The problem:** By passing `'FETCH'` as the intent type, the planner was only generating FETCH (resolution) steps, not the complete MODIFY plan with both resolution and modification steps.

## Solution
Changed the re-planning call to use `'MODIFY'` intent type:
```typescript
const tablePlanResponse = await sendToPlanner(refinedQuery, apiKey, usefulData, conversationContext, 'MODIFY', true);
```

With this change:
1. The planner receives intent type `'MODIFY'` 
2. The prompt explicitly instructs: "You must produce the COMPLETE remaining execution plan (all steps) required to fulfill the goal, including any prerequisite data fetch/resolution steps followed by the modification step(s)"
3. The `forceFullPlan=true` flag reinforces this with an additional instruction: "PRIOR RESPONSE WAS RESOLUTION-ONLY. DO NOT STOP AT RESOLUTION. RETURN THE ENTIRE EXECUTION_PLAN WITH MODIFICATION STEPS INCLUDED."

## Files Changed
- `/app/api/chat/route.ts` - Lines 548-559

## Impact
- Users will now see complete execution plans for all MODIFY intents, including all prerequisite steps
- The plan display will properly show all steps with correct step numbers and descriptions
- Phase information will be correctly set (showing either "resolution", "execution", or appropriate phase)

## Testing
To test, trigger a MODIFY intent like:
- "Remove Metapod from my watchlist"
- "Add Charizard to my team"
- "Delete this item"

Verify that the plan shows:
1. All prerequisite steps (usually fetching required IDs via SQL queries)
2. The final modification step (DELETE, POST, PUT, etc.)
3. Correct phase information
4. All steps properly formatted with step numbers and descriptions
