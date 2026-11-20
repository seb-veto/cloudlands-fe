# Sentry error reporting

Set `INTENT_ERROR_REPORTING_DSN` to the project's public HTTPS Client Key (DSN) in the environment that launches the forked desktop app. The desktop passes this setting to the local daemon it starts. Configure the same variable on each independently managed daemon, including remote workers. Use the patched desktop and daemon from the same upstream beta. Leaving the variable unset disables reporting.

The desktop reports uncaught main-process exceptions and rejections, first-party renderer console errors, and abnormal renderer and helper exits. The daemon reports first-party error events and terminal agent failures. Reports include the component, release, and an app code location or a fixed crash reason when available. Error messages, prompts, tool outputs, workspace paths, and crash dumps stay local.

For a live check, trigger a synthetic application failure in a disposable instance and verify the event in the project's Issues view. Confirm the component, release, and code location before rolling out to other machines.
