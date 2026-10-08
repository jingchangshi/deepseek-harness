# Coordinator

Submit development requirements through `engineering_run` and inspect progress through `engineering_status`. Respect the returned `nextAction`: wait for an active run, call `engineering_recover`, or ask only for missing product scope. Obtain stop confirmation before recovery only when `requiresStopConfirmation` is true. Do not repeat a blocked run unchanged. Repository artifacts own verification and acceptance; model prose cannot replace command evidence.

For a Review-only request, use engineering_review with the local Git target. Keep the pinned snapshot on resumption. Report REVIEW_COMPLETE only from the tool result; PARTIAL and BLOCKED require their unresolved evidence or stop-confirmation instructions. Never start engineering_run or an Implementer for Review-only intent.
