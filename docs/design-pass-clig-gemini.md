# Design Pass: CLIG.dev Principles

### Finding 1: Missing EXAMPLES and EXIT CODES in Help
- **File:** src/cli.ts:46
- **Clig.dev principle:** "Include examples." / "Include exit codes."
- **Severity:** medium
- **Current behavior:** The `--help` text provides a basic usage synopsis and options but lacks concrete examples, an exit codes table, and a SEE ALSO section.
- **Recommended:** Expand the help output with a dedicated "Examples" section and document expected exit codes (e.g., 0 for success, 1 for error, 2 for misuse).

### Finding 2: Inflexible version format
- **File:** src/cli.ts:60
- **Clig.dev principle:** "It’s better to output a single string, e.g. 1.2.3, rather than MyProgram version 1.2.3... Or if you want to include more info, do it nicely."
- **Severity:** low
- **Current behavior:** Outputs `petricode 0.1.0`. Scripts parsing for the version number must strip the "petricode " prefix.
- **Recommended:** Output just the raw version string `0.1.0` to be trivially machine-readable, or provide a structured format (like `--version --format json`) with full commit and build date details.

### Finding 3: Flag parsing ignores end-of-options (`--`)
- **File:** src/cli.ts:50
- **Clig.dev principle:** "Use a double dash to indicate the end of options."
- **Severity:** high
- **Current behavior:** The naive array searches (e.g., `args.includes("--version")`) will mistakenly intercept flags embedded within a prompt. Running `petricode -p "--version"` triggers the version exit instead of passing the string to the model.
- **Recommended:** Stop parsing flags when `--` is encountered, and ensure positional arguments or string arguments (like the prompt) are not conflated with top-level flags.

### Finding 4: First-wins instead of last-wins for repeated flags
- **File:** src/cli.ts:76
- **Clig.dev principle:** "If a flag is given multiple times, the last one wins."
- **Severity:** medium
- **Current behavior:** `args.indexOf()` captures the *first* occurrence of a flag. If a user sets an alias or script that defaults to `-p "default"` and tries to override it via `petricode -p "default" -p "override"`, the CLI ignores the override.
- **Recommended:** Use `lastIndexOf()` or a robust CLI parser so the right-most (latest) flag wins.

### Finding 5: Exit codes for command misuse are generic
- **File:** src/cli.ts:79
- **Clig.dev principle:** "Catch errors and report them: Tell the user what went wrong, and what they can do to fix it."
- **Severity:** medium
- **Current behavior:** Missing arguments for `--resume` or `-p` exit with a generic `1`. Also, the error for `-p` (`-p/--prompt requires a prompt string.`) lacks an actionable fix/example.
- **Recommended:** Exit with code `2` for syntax/misuse errors. Add a brief example to the `-p` error (e.g., `Usage: petricode -p "fix my code"`).

### Finding 6: TTY not detected automatically
- **File:** src/cli.ts:98
- **Clig.dev principle:** "Determine if the output is a terminal or not"
- **Severity:** high
- **Current behavior:** The application defaults to booting the TUI unless `-p/--prompt` is explicitly passed. Redirecting input/output (e.g., `petricode < input.txt` or `petricode > out.txt`) without `-p` will boot Ink into a non-interactive stream, which can hang or crash.
- **Recommended:** Check `process.stdin.isTTY` and `process.stdout.isTTY`. If false, either automatically fallback to headless mode or fail gracefully with a clear message stating a TTY is required.

### Finding 7: YOLO mode for destructive actions in headless environments
- **File:** src/headless.ts:13
- **Clig.dev principle:** "Never assume it's OK to do destructive things. Prompt the user for confirmation... provide a `--force` or `--yes` flag to bypass."
- **Severity:** high
- **Current behavior:** Headless runs implicitly auto-allow all tools, including destructive shell scripts and file modifications, without explicit user consent.
- **Recommended:** Require an explicit `--yes` flag to bypass safety. If not provided, either reject destructive tools automatically or require user confirmation (which fails in headless, thus returning a clear "User confirmation required but running in non-interactive mode" error).

### Finding 8: Unhandled SIGPIPE (broken pipe)
- **File:** src/cli.ts:31
- **Clig.dev principle:** "Handle SIGPIPE."
- **Severity:** medium
- **Current behavior:** If output is piped (e.g., `petricode -p "..." | head -n 1`) and the consumer closes the pipe early, the application doesn't catch the `EPIPE` error emitted by standard out, which can lead to a noisy stack trace instead of a silent exit.
- **Recommended:** Add a listener for `EPIPE` on `process.stdout` and exit silently with code `141`.

### Finding 9: Inconsistent slash command naming
- **File:** src/commands/index.ts:10
- **Clig.dev principle:** "Make your subcommands verbs... if it's manipulating a resource, verb-noun or noun-verb."
- **Severity:** low
- **Current behavior:** The internal TUI slash commands are a mix of verbs (`/clear`, `/compact`) and nouns (`/model`, `/skills`).
- **Recommended:** Standardize the naming to be consistently action-oriented (e.g., `/set-model` or `/switch`, and `/list-skills`).

### Finding 10: Configuration lacks comment support
- **File:** petricode.config.example.json
- **Clig.dev principle:** "Configuration: Use a format that supports comments."
- **Severity:** low
- **Current behavior:** The sample configuration uses standard `.json`, which strictly forbids comments, making it harder for users to annotate configuration tiers and model fallbacks.
- **Recommended:** Use formats like JSONC, TOML, or YAML, which allow users to comment out experimental sections or leave inline documentation.