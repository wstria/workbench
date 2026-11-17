# Workbench

A local-first desktop workspace for files, web research, and coding agents. Open a source in its own tab, attach it from chat with `@`, and use Activity to pick up an interrupted task or review an agent's changes.

## Start on macOS

The preview build targets Apple Silicon. From source, use macOS, Git, Node.js 22.19 or newer, and npm. Install the Xcode Command Line Tools if the native terminal module needs to compile.

```sh
npm ci
npm start
```

Open **Settings → Providers** to connect a model. Pi is the built-in default. External harnesses use their own installations and credentials. Select a harness in **Settings → Harnesses** for new chats, then choose one of its available models in the composer. Existing chats stay with their original harness.

`npm run package` builds `dist/mac-arm64/Workbench.app` on Apple Silicon. `npm run dist` also creates distributable targets. Developer ID signing and Apple notarization require release credentials. The preview uses ad-hoc signing and requires a local build or your organization’s developer installation process.

## Use the workbench

| Task | Where to start |
| --- | --- |
| Find a source | Use `⌘P` to search files, selectable PDF text, saved web excerpts, and conversations. Search by `#tag`. Results can open the original, attach an excerpt, or copy a Workbench link. |
| Capture research | Bookmark a loaded page or select a passage and use **Save passage**. Use `@` in chat to attach the saved excerpt. Open an existing Markdown vault from **Artifacts → Knowledge** to browse tags, links, and backlinks. |
| Review a coding change | Pick a Git workspace. In the composer, open **Workspace details → Work on a separate copy** and review the starting branch and revision. Open **Review changes** from chat or Activity to select files or hunks. Workbench checks the target before applying and records the changes it can undo. |
| Resume work | Use **Activity → Needs attention** for approvals, reviewable changes, failed runs, and computer handoffs. Recent records results. Upcoming and Calendar show scheduled work. Workbench restores queued messages and asks before retrying an interrupted run. |
| Triage email | Open **Integrations → Inbox triage**, then connect a [Fastmail read-only JMAP token](https://www.fastmail.help/hc/en-us/articles/5254602856719-API-tokens). Review prioritized threads and draft replies locally. The briefing preset lets you explicitly include recent mail in a scheduled model request. |
| Run a desktop task | Open **Computers**, create a local or Daytona desktop, and select **Open agent chat**. Choose **Take control** to complete a sign-in. Finish signing in and dismiss sensitive screens before choosing **Release control**. |
| Add tools | Open **Integrations** to inspect and enable an MCP server, create or import a skill, or import a Pi extension. Choose the integrations available to an automation in its task editor. |

## Computers

Local computers use Tart on Apple Silicon and keep their Linux guest disks in Workbench's application data directory. The first start downloads an Ubuntu image and sets up the desktop. The guest has its own filesystem. Export a result from the guest into Workbench Artifacts to open it on the host.

For a cloud computer, choose **Computers → Connect Daytona** and supply your own API key. Workbench stores it using the operating system's credential storage. Create a computer using the **Daytona** provider and start it. Workbench provisions a private sandbox in your Daytona account and uses the [Daytona Computer Use API](https://www.daytona.io/docs/en/computer-use/) for the preview and controls. Daytona usage and storage are billed by Daytona. Use **Stop** to stop a sandbox and **Remove** to delete its remote disk. An idle sandbox is configured to stop after 15 minutes. A disconnected computer can be stopped or reconnected from its tab after relaunch.

## Local data and network access

Workspace files stay in their original folders. Locally generated notes, artifacts, run records, saved excerpts, and app data can be opened from Settings. Model calls send the prompt and attached context to the selected provider. Fastmail, Daytona, enabled integrations, and external harnesses connect to their respective services. Scheduled tasks run while the app is open and require explicit access to optional tools. Workbench leaves email replies as local drafts.

## Verify a build

```sh
npm test
npm run package
npm run test:packaged
npm run test:inbox
npm run demo:seed -- ./workbench-demo
```

`test:packaged` starts disposable profiles and a localhost fixture provider. It uses the actual Mac app for research and Git testing and an Electron launcher wired to a fake Daytona SDK for cloud testing. Pass paths to the current and previous `.app` bundles to include the upgrade check. Set `WORKBENCH_KEEP_FIXTURE=1` to keep successfully tested profiles for inspection. Failures keep their profiles and any available UI snapshot.

See [the demo steps](docs/demo.md) and [the verification report](docs/release-verification.md) for tested paths and first-preview limits.

[MIT license](LICENSE)
