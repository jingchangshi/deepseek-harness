# Pebble compiler instructions

Pebble input uses single-assignment integer values, `const`, `add`, `mul`, and a final `ret`. Reject undefined operands and duplicate definitions. Fold arithmetic before emitting stack or register target IR. Multiplication must preserve integer arithmetic. Keep both target encodings equivalent to the input program. Write generated targets only under ignored `task.runtime/`. Board qualification is optional for presubmit acceptance.
