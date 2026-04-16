# Claude Code UX Behavioral Spec

Behavioral feature list only. Describes what the UX does from a user perspective.
No function names, variable names, code structure, prompt text, or internal architecture.
Source: observable product behavior.

## Global Layout & Rendering
1. Persistent, full-terminal interactive TUI (not a command-response loop)
2. Persistent status bar anchoring session context
3. Status bar displays current working directory
4. Status bar displays accumulated monetary cost of session
5. Status bar displays total elapsed session duration
6. Status bar displays context size / token utilization
7. Visual dividers separate user turns from assistant turns
8. Text wraps to terminal width
9. Terminal resize reflows text and dividers without corruption
10. Respects terminal's native background color (dark/light mode)
11. Strips ANSI formatting when piped to file or non-TTY

## Input Prompt & Text Editing
12. Persistent input indicator (e.g., `>`) for the typing area
13. Input area expands vertically for multiline text
14. Enter submits the prompt
15. Shift+Enter (or Alt+Enter) inserts a literal newline without submitting
16. Ctrl+A / Home — cursor to beginning of line
17. Ctrl+E / End — cursor to end of line
18. Alt+B / Ctrl+Left — cursor backward one word
19. Alt+F / Ctrl+Right — cursor forward one word
20. Ctrl+U — kill from cursor to beginning of line
21. Ctrl+K — kill from cursor to end of line
22. Ctrl+W — delete word behind cursor
23. Alt+D — delete word ahead of cursor
24. Ctrl+L — clear terminal screen (session/context preserved)
25. Ctrl+C while assistant is generating — interrupt current action
26. Ctrl+C at empty prompt — exit the application
27. Ctrl+D at empty prompt — EOF, exit
28. Pasting multiline text inserts without triggering premature submission
29. Up Arrow — navigate backward through prompt history
30. Down Arrow — navigate forward through prompt history
31. Prompt history preserved across restarts
32. Partially typed text preserved when navigating history

## Slash Commands & Autocomplete
33. `/` as first char triggers slash command mode
34. Interactive autocomplete menu appears on `/`
35. Autocomplete filters as user types
36. Tab auto-completes highlighted command
37. `/help` — usage instructions, commands, shortcuts
38. `/clear` — wipe visual history
39. `/compact` — compress conversation to free context
40. `/cost` — token usage and billing breakdown
41. `/history` — list past sessions
42. `/resume` — switch to a past session
43. `/config` — display/edit settings
44. `/login` — initiate authentication
45. `/logout` — clear local credentials
46. Invalid slash command shows inline error, not sent to model

## Execution Phases & State Machine
47. Input area locks and shows processing state on submit
48. "Thinking" state with animated spinner
49. Spinner animates continuously during network requests
50. Tool execution shows distinct "Tool Execution" state
51. UI displays name/action of currently executing tool
52. Tool arguments, paths, parameters summarized in UI
53. Live elapsed-time indicator for long-running tools
54. Tool completion: static checkmark (success) or X (failure)
55. Multiple tool calls visually stacked/grouped
56. Direct-to-user text: "Streaming" state
57. Text streamed token-by-token into terminal
58. On completion, returns to "Idle" with input prompt restored

## Confirmation Flow & Safety Barriers
59. High-risk shell commands trigger interactive confirmation
60. High-risk file modifications trigger confirmation
61. Confirmation shows exact literal command/modification queued
62. User inputs y/n to approve or reject
63. Enter without letter defaults to safe action (often no for destructive)
64. "Reject with feedback" option — type reason for rejection
65. "Approve always" option — add to local whitelist
66. "Approve all for session" — bypass future prompts this session
67. Confirmation waits indefinitely (no timeout)
68. Rejection + feedback fed back to session context for assistant to pivot

## Output Rendering & Formatting
69. Full Markdown parsing and rendering
70. Bold via terminal ANSI bold
71. Italic via terminal ANSI italic
72. Inline code with distinct background/highlight
73. Code blocks in visually distinct bounding boxes
74. Syntax highlighting per language in fenced blocks
75. Bulleted/numbered lists indented and aligned
76. Markdown tables rendered with box-drawing characters
77. URLs rendered as clickable terminal hyperlinks (if supported)
78. File modifications rendered as contextual diffs
79. Diff added lines: `+` prefix, green
80. Diff removed lines: `-` prefix, red
81. Diff context lines: standard color
82. Large tool outputs paginated/truncated
83. "[output truncated]" indicator when limit exceeded
84. Tool outputs rendered dimmed/muted vs conversational text
85. Verbose JSON collapsed by default

## Error Display & Handling
86. System errors in high-contrast red
87. Stack traces sanitized to user-friendly summaries
88. Failed tool execution output rendered visibly
89. Failed tools auto-piped back to assistant for retry
90. Retry counter badge if assistant retries
91. Yellow/orange warning when context window near limit
92. Specific "output too large" error for oversized tool output

## File & Context Awareness
93. On init, probes for Git repository
94. Shows workspace/repo name and active branch in header
95. File searches respect .gitignore
96. Directory listings formatted as clean tree (not raw JSON)
97. File reads show acknowledgment, not full file dump

## Color Usage
98. Assistant text: terminal default foreground
99. User input/prompt: distinct accent color
100. Success/checkmarks/additions: green
101. Warnings/pending/near-limit: yellow/orange
102. Errors/destructive/removals: red
103. Metadata/timestamps/tokens/paths: dimmed gray

## Authentication & Onboarding
104. First launch: welcome screen, prompt to authenticate
105. Login spawns default browser for OAuth
106. Fallback auth URL printed for headless environments
107. "Waiting for authentication" spinner during browser flow
108. Auto-detects successful OAuth callback
109. Success message, then straight to prompt

## Session Management
110. Prompts and responses auto-saved to local database
111. Restart in same directory auto-restores prior session
112. Session browser: interactive list with arrow key navigation
113. Selecting past session replaces current visual state
114. Sessions auto-titled from first prompt summary
