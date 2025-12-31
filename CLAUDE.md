# Copilot Execution Contract (Anti-Stall)

## CORE RULE (NON-NEGOTIABLE)

You **cannot work in the background**.

If a message does **not** contain concrete, user-visible output
(code, schema, file content, or an explicit failure reason),
**NO WORK is considered done.**

Any claim of progress **without output** is a violation.

---

## MANDATORY WORKFLOW

### 1. PLAN (REQUIRED)

* Create `.temp/plan.md` if missing
* Status must be `PENDING_APPROVAL`
* Plan MUST include:

  * Summary
  * Checklist (atomic, verifiable steps)
  * Files affected
  * Risks
  * Complexity

### 2. APPROVAL

* Wait for **explicit approval**
  (`yes | approve | go ahead | proceed | ok | confirm`)
* No execution before approval

### 3. EXECUTION

* Execute **EXACTLY ONE checklist step per message**
* That message MUST contain the **actual output** of the step
* No output = step **not started**

After producing output:

* Mark step `[x]` in `plan.md`
* Update `Last Updated`
* Explicitly state: `Step N completed`

---

## CHECKLIST RULES (STRICT)

Each checklist item MUST:

* Represent one atomic action
* Define expected concrete output
* Be verifiable by inspecting the output

❌ Invalid: “Improve API schema”
✅ Valid: “Output full response schema JSON for POST /pokemon/search with field-level descriptions”

---

## FAILURE / BLOCKED RULE

If a step cannot be completed:

* Explain **exactly** what is missing
* Stop execution immediately
* Do NOT mark the step complete
* Do NOT defer to a future message

---

## FORBIDDEN BEHAVIOR (ANTI-STALL)

You MUST NOT:

* Claim progress without output
* Say “working on it”, “in progress”, “please wait”
* Defer execution to a later message
* Mark a step complete without visible results

---

## RESUME RULE

On “resume” / “continue”:

* Read `.temp/plan.md`
* Report:

  * Original task
  * Completed steps `[x]`
  * Remaining steps `[ ]`
* Execute the **next unfinished step immediately**
  OR fail fast with a blocking reason

---

## I18N RULES (STRICT)

* NEVER hardcode user-facing text
* ALWAYS use `t("key.path")`
* ALWAYS update BOTH:

  * `locales/en.json`
  * `locales/zh.json`
* Reuse existing keys when possible
* Follow existing nesting structure

---

## TECH RULES

* Next.js 13+: use `next/navigation`
* All API calls under `./services/`
* TypeScript only, fully type-safe
* Import shared functions as:
  `import { fn } from "@/services/file"`

---

## FINAL GUARANTEE

Execution **only exists when output exists**.
If nothing is produced, nothing happened.
