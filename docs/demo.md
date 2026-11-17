# Demo Workbench

Run `npm run demo:seed -- ./workbench-demo` to create a new folder with a two-page agreement, a linked Markdown note, a sample web page, and a small Git project with a failing test. `npm run test:packaged` starts the reproducible model and browser fixtures automatically. Use a disposable profile for app testing.

1. Open the seeded folder in **Files**. Use `⌘P` to find `terminate this agreement`. Open the result and verify that the PDF opens at page 2. Open `Research.md` and try the `[[Harbor agreement.pdf]]` link.
2. In a chat backed by a configured model, type `@terminate this agreement` and attach the PDF excerpt. Ask for a one-sentence summary. Click the attachment in the turn to return to the original page. Save a brief as Markdown.
3. Bookmark a loaded webpage, close its tab, and search for a sentence inside it. Open the saved source or attach the excerpt to a chat. Use a favorite's tags to find it again by topic.
4. In a new chat, choose the demo Git folder and open **Workspace details**. Choose **Work on a separate copy** and ask the agent to fix the calculator and run `node calculator/add.test.cjs`. Open its result from **Activity → Needs attention**, select the change, and apply it. Undo from the same review. The test should fail again. Run a second session from a separate copy to see how reviews stay independent.
5. In **Integrations → Inbox triage**, connect a read-only Fastmail token if available. Open a thread, inspect its original, and save a local reply draft. Choose **Schedule a briefing**, check the included tools, and open the completed run from Activity.
6. In **Computers**, start a local guest or a Daytona sandbox. Open its agent chat and ask it to prepare a fixture sign-in page and request takeover. Enter only fixture credentials, complete the sign-in, and release control. Have the agent export a text receipt and open the artifact from Activity.
