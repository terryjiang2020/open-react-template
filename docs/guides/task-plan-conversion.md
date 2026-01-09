# Task Plan → /tasks API Conversion Guide

_Last updated: 2026-01-04_

This guide explains how to turn a chat plan response (from the chat history) into the payload for `POST /tasks`. Use it when the user clicks **"Save this task"** under a plan message.

## Source data
- Assistant plan message: contains human-readable plan markdown and `planSummary` (structured steps/goal) plus `sessionId`.
- Conversation history: previous assistant response that includes the plan; do **not** rely on user messages for structure.

## Target API
`POST /tasks` (see `temp/task_api.json`)
```json
{
  "taskName": "string",
  "taskType": 1,
  "taskContent": "string",
  "taskSteps": [
    { "stepOrder": 1, "stepType": 1, "stepContent": "string" }
  ]
}
```
- `taskType`: integer (e.g., 1=FETCH, 2=MODIFY). Derive from plan phase/intent if available; otherwise default to 1 (FETCH/read).
- `taskSteps`: array of steps preserving order.

## Mapping rules
1) **Task name**
- Prefer the plan goal if present (`planSummary.goal` or refined query text). Fallback to first line/heading of the assistant plan message.
- Keep it short (≤120 chars). Trim whitespace.

2) **Task type**
- If plan phase/intent suggests a write (e.g., includes DELETE/POST/PATCH/PUT), use `2` (MODIFY).
- Otherwise use `1` (FETCH).
- If mixed, prefer `2` (MODIFY).

3) **Task content**
- Use the assistant plan message markdown as the main content.
- If absent, serialize `planSummary` as formatted markdown or JSON string.

4) **Task steps**
- Source: `planSummary.steps` if available; else extract bullet/numbered steps from the assistant plan message.
- For each step, set:
  - `stepOrder`: 1-based order as displayed to the user.
  - `stepType`: derive from HTTP method if present (GET→1/FETCH, POST|PUT|PATCH|DELETE→2/MODIFY). Unknown → 1.
  - `stepContent`: concise text combining description + technical detail (e.g., `"Delete team" — DELETE /pokemon/teams/{teamId}`).
- Preserve original sequence; do not reorder.

5) **Filtering / sanitization**
- Remove approval CTA text (e.g., “Reply with approve”).
- Strip code fences/triple backticks from stepContent values.
- Keep parameters/bodies only if they help identify the action; avoid leaking tokens or secrets.

6) **When data is missing**
- If no structured steps are found, send a single step with the entire plan message as `stepContent` and `stepType=1`.
- If `taskName` would be empty, set to `"Untitled task"`.

7) **Authentication**
- Include bearer token in the request (`Authorization: Bearer <token>`). Do not send if token is absent; surface an error toast instead.

8) **Sample conversion (from `temp/chat.txt` plan)**
- Goal/Name: `Delete the Aqua Team`
- Type: `2` (DELETE step)
- Content: the assistant plan markdown
- Steps:
  - Step 1: `stepOrder=1`, `stepType=1`, `stepContent="Query team id" — POST /general/sql/query`
  - Step 2: `stepOrder=2`, `stepType=2`, `stepContent="Delete team" — DELETE /pokemon/teams/{teamId}`
  - Step 3: `stepOrder=3`, `stepType=1`, `stepContent="Verify deletion" — POST /general/sql/query`

## Pseudocode outline
```
input: assistantMessage (content, planSummary, sessionId)

plan = assistantMessage.planSummary
text = assistantMessage.content

taskName = plan.goal || firstHeading(text) || 'Untitled task'
taskType = plan.intent === 'MODIFY' || hasWriteStep(plan) ? 2 : 1

taskContent = text

steps = plan.steps || extractStepsFromText(text)
if (!steps.length) steps = [{ desc: text, method: 'GET' }]

map steps -> taskSteps:
  stepOrder = index+1
  stepType = methodIsWrite ? 2 : 1
  stepContent = `${desc} — ${method && path ? `${method} ${path}` : ''}`.trim()

payload = { taskName, taskType, taskContent, taskSteps }
```

## QA checklist before calling /tasks
- Payload matches schema (all required fields present).
- At least 1 step.
- No code fences in strings.
- taskType set to 2 if any write/delete step exists.
- Token present; otherwise abort with user-facing error.
