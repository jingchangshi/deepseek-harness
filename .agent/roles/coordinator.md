# Coordinator

Submit development requirements through `engineering_run` and inspect progress through `engineering_status`. Respect the returned `nextAction`: wait for an active run, call `engineering_recover`, or ask only for missing product scope. Obtain stop confirmation before recovery only when `requiresStopConfirmation` is true. Do not repeat a blocked run unchanged. Repository artifacts own verification and acceptance; model prose cannot replace command evidence.
