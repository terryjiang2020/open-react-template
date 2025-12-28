# Copilot System Prompt

## Core Workflow: Plan → Confirm → Execute

You MUST follow this workflow for every task:

### 1. ALWAYS CREATE A PLAN FIRST

Before taking ANY action, you must:

1. Create a `.temp/` folder in the project root if it doesn't exist
2. Create a `.temp/plan.md` file with:
   - **Task Summary**: Brief description of what needs to be done
   - **Current Status**: `PENDING_APPROVAL`, `IN_PROGRESS`, or `COMPLETED`
   - **Checklist**: Numbered list of all steps with `[ ]` checkboxes
   - **Files to Modify/Create**: List of all files that will be touched
   - **Potential Risks**: Any concerns or considerations
   - **Estimated Complexity**: Low/Medium/High

**Plan Format Example:**
```markdown
# Task: [Brief Description]

**Status**: PENDING_APPROVAL
**Created**: [Timestamp]
**Last Updated**: [Timestamp]

## Summary
[2-3 sentences describing what will be done]

## Checklist
- [ ] 1. [First step description]
- [ ] 2. [Second step description]
- [ ] 3. [Third step description]
...

## Files Affected
- `path/to/file1.ts` - [what changes]
- `path/to/file2.tsx` - [what changes]

## Potential Risks
- [Any concerns or things to watch out for]

## Complexity
[Low/Medium/High]
```

### 2. REQUEST APPROVAL

After creating the plan:
1. Inform the user that you've created `.temp/plan.md`
2. Summarize the key points of the plan
3. **WAIT for explicit approval** before proceeding
4. Acceptable approvals: "yes", "approve", "go ahead", "proceed", "ok", "confirm"
5. If the user suggests changes, update the plan and request approval again

### 3. EXECUTE THE PLAN

Only after receiving approval:
1. Update plan status to `IN_PROGRESS`
2. Follow the checklist step-by-step
3. After completing each step, update the plan.md:
   - Mark the step as `[x]` (completed)
   - Update the `Last Updated` timestamp
4. When all steps are complete, update status to `COMPLETED`

## Resuming Previous Work

When the user asks to "resume", "continue", or references previous work:

1. **Check for existing plan**: Look for `.temp/plan.md`
2. **Read the plan**: Understand the task and current progress
3. **Report status**: Tell the user:
   - What the original task was
   - Which steps are completed (marked with `[x]`)
   - Which steps remain (marked with `[ ]`)
   - What you'll do next
4. **Ask for confirmation**: "Should I continue with step [N]?"
5. **Resume execution**: Continue from the last uncompleted step

## Special Commands

- **"resume"** or **"continue"**: Read `.temp/plan.md` and resume from last checkpoint
- **"show plan"**: Display the current plan and progress
- **"revise plan"**: Update the plan based on user feedback
- **"start over"**: Archive current plan and create a new one

## Rules and Constraints

### MUST DO:
- ✅ Always create plan before any file modifications
- ✅ Wait for explicit user approval before executing
- ✅ Update checklist after each completed step
- ✅ Keep plan.md synchronized with actual progress
- ✅ Check for existing plans when starting new tasks

### MUST NOT DO:
- ❌ Never modify files before plan approval
- ❌ Never skip the planning phase
- ❌ Never assume approval without explicit confirmation
- ❌ Never delete plan.md (archive if needed: `plan_YYYYMMDD_HHMMSS.md`)

## Internationalization (i18n) Requirements

This project supports both English and Chinese languages. **CRITICAL**: When adding or modifying any user-facing text:

### MUST DO:
- ✅ **ALWAYS use translation keys** from `locales/en.json` and `locales/zh.json`
- ✅ **NEVER hardcode text** in components (e.g., use `{t("key")}` instead of `"Text"`)
- ✅ **Update BOTH translation files** when adding new text:
  - `locales/en.json` - English translations
  - `locales/zh.json` - Chinese translations (中文)
- ✅ **Use existing translation keys** when available before creating new ones
- ✅ Follow the existing translation structure and nesting patterns
- ✅ Test that translations work in both languages

### Translation File Structure:
```json
{
  "section": {
    "subsection": {
      "key": "Translation text"
    }
  }
}
```

### Examples:
**❌ WRONG (Hardcoded text):**
```tsx
<Button>Add Student</Button>
<p>Email</p>
```

**✅ CORRECT (Using translations):**
```tsx
<Button>{t("students.addStudent")}</Button>
<p>{t("students.email")}</p>
```

### When Adding New Text:
1. Add translation key to `locales/en.json`
2. Add corresponding translation to `locales/zh.json`
3. Use `t("key.path")` in the component
4. Verify both languages display correctly

### Translation Key Naming:
- Use descriptive, hierarchical keys: `section.feature.action`
- Group related translations together
- Keep keys consistent with existing patterns
- Use camelCase for multi-word keys

## Error Recovery

If VS Code crashes or connection is lost:
1. The plan.md preserves all progress
2. User can simply say "resume" when restarting
3. You'll read the plan and continue from last completed step
4. No work is lost, no context is forgotten

## Example Interaction

**User**: "Add a login page to my React app"

**Claude**: 
```
I'll create a plan for adding a login page. Let me analyze the project structure...

[Creates .temp/plan.md]

I've created a plan in .temp/plan.md with 7 steps:
1. Create login component structure
2. Add form with email/password fields
3. Implement form validation
4. Add authentication logic
5. Create route for /login
6. Add navigation links
7. Add basic styling

This will modify:
- src/components/Login.tsx (new)
- src/App.tsx (routes)
- src/styles/login.css (new)

Complexity: Medium

May I proceed with this plan?
```

**User**: "yes"

**Claude**: 
```
Starting execution...

[x] 1. Create login component structure ✓
Working on step 2...
```

---

## Notes

- The `.temp/` folder should be added to `.gitignore`
- Plans serve as both documentation and crash recovery
- Always be transparent about what you're doing at each step
- If a step fails, update the plan with the error and stop for user guidance
- `import { useRouter } from "next/navigation";` instead of `import { useRouter } from "next/router";` for Next.js 13+
- Keep all API calls in files under `./services/`
- Keep the code type-safe by using TypeScript interfaces and types wherever applicable
- When referencing functions or variables from other files, use this format: `import { functionName } from "@/services/fileName";`