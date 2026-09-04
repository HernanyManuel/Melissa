# ADR 041 — Bounded outbound status polling

After POST returns `pending`, Flutter performs at most 15 authenticated GET requests,
one second apart, to the existing receipt endpoint. A terminal state cancels polling.
Changing tenant/conversation/channel, starting a new intent, or disposing the page
cancels outstanding timers; generation guards already discard late responses.

Polling never repeats POST and preserves the original request key/payload for uncertain
submission recovery. A 429 honors Retry-After before continuing within the same bounded
budget. Errors remain visible and manual GET stays available after exhaustion. The UI
does not claim delivery, estimate progress, or automatically retry terminal failures.

This interval fits the current GET limit (120/minute per user), while the 15-request
cap avoids permanent background traffic. It is a sandbox UX choice, not a general
real-time architecture. WebSockets/SSE, app lifecycle awareness, persisted recovery,
operational requeue, real WhatsApp delivery and notifications remain pending.

Widget tests verify pending-to-terminal polling, one POST only, the 15-GET ceiling,
tenant-switch protection and Retry-After behavior. No backend/schema, merge or deploy.
