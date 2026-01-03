# Plan Approval Workflow

## Overview

The chat API now implements a **plan approval workflow** that requires user confirmation before executing any API calls. This ensures transparency and user control over automated operations.

## How It Works

### 1. Plan Generation Phase

When a user sends a query:
1. The system analyzes the query and generates an execution plan
2. Instead of executing immediately, the plan is stored in memory
3. The plan is formatted and returned to the user for review

### 2. User Review

The user receives a formatted plan showing:
- **Goal**: What the system is trying to achieve
- **Phase**: Whether it's a resolution or execution phase
- **Planned Steps**: Detailed breakdown of API calls
  - Step number and description
  - API endpoint (method + path)
  - Parameters and request body

### 3. User Approval

The user can respond in two ways:

#### Option A: Approve the Plan
Reply with any of these keywords (case-insensitive):
- `approve`
- `yes`
- `proceed`
- `ok`
- `confirm`
- `go ahead`

The system will then execute the approved plan and return the final results.

#### Option B: Reject or Modify
Reply with:
- Any feedback or modifications
- A completely new query

The system will:
1. Discard the pending plan
2. Generate a new plan based on the feedback
3. Present the new plan for approval

## Session Management

- **Session ID**: Generated from conversation context to track pending plans
- **Timeout**: Pending plans expire after 1 hour
- **Cleanup**: Automatic cleanup runs every 5 minutes

## Example Flow

```
User: "Remove Metapod from my watchlist"

System: 
## 📋 Execution Plan

**Goal:** Remove Metapod from my watchlist

**Phase:** resolution

**Planned Steps:**

1. Search for Pokémon named 'Metapod' to retrieve its internal ID
   - API: `POST /pokemon/search`
   - Parameters: ```json
{}
```
   - Body: ```json
{
  "searchterm": "Metapod"
}
```

---

**Please review the plan above. Reply with "approve" to execute, or provide feedback to regenerate.**

User: "approve"

System: [Executes the plan and returns final results]
```

## Benefits

1. **Transparency**: Users see exactly what will be executed
2. **Control**: Users can prevent unwanted operations
3. **Debugging**: Easier to identify issues in the planning phase
4. **Iterative**: Users can refine queries before execution
5. **Safety**: Prevents accidental data modifications

## Technical Details

### Storage Mechanism
- In-memory Map structure
- Key: Session ID (hash of conversation context)
- Value: Complete plan state including:
  - Execution plan
  - Query metadata
  - Conversation context
  - Timestamp

### Cleanup Policy
- Plans expire after 1 hour
- Cleanup runs every 5 minutes
- Approved plans are immediately removed from storage
- Rejected plans are removed on next user message

### Error Handling
- If API key is missing, returns error before plan generation
- If no execution plan is generated, returns appropriate message
- If execution fails after approval, returns detailed error with context
