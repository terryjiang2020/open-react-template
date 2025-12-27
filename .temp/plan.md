# Task: Debug chat agent API call to `/user/account` failing while Postman succeeds

**Status**: IN_PROGRESS
**Created**: 2025-12-27T00:00:00Z
**Last Updated**: 2025-12-27T00:12:00Z

## Summary
The chat agent's API call to `https://devserver.elasticdash.com/api/user/account` reports failure while the same request succeeds in Postman. We'll inspect the chat widget's tool-call implementation, verify headers (especially `Authorization`) and base URL, check client/server context and CORS, then implement a fix by centralizing API calls (axios util) or adding a server-side proxy route to reliably forward auth. We'll test the change and improve error logging.

## Checklist
- [x] 1. Review `components/chat-widget.tsx` API call logic and headers
 - [x] 2. Check env config for base URL and token handling (`.env.local`, `next.config.js`)
 - [x] 3. Identify network context (client vs server) and CORS requirements
 - [x] 4. Add API client util with proper headers or server-side proxy route
 - [x] 5. Update chat agent to use the fixed client/proxy
 - [x] 6. Add structured error logging with response details (status code, message)
- [ ] 7. Test in dev and confirm `/user/account` shows email info
- [ ] 8. Update plan status to COMPLETED

## Files Affected
- `components/chat-widget.tsx` - adjust tool call to use util/proxy with Authorization
- `utils/api.ts` - new axios instance with base URL and headers from cookie/localStorage
- `app/api/proxy/user/account/route.ts` - new Next.js API route to proxy external call server-side
- `.env.local` - add `NEXT_PUBLIC_API_BASE_URL` for external API base URL
- `README.md` - add brief note on configuring API base URL and auth token

## Potential Risks
- Token must not be hardcoded; ensure secure retrieval from session/cookie/storage
- Browser-side requests may hit CORS; prefer server-side proxy for reliability
- Token expiry and refresh may be needed (out of scope if not implemented)

## Complexity
Medium
