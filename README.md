# Speak Flow

Build a polished, usable MVP for an AI-powered English and Japanese speaking-practice app.

First inspect the current workspace, existing files, framework, and available dependencies. Reuse the existing stack and conventions where possible. If the workspace is empty, create a lightweight React-based frontend using the simplest suitable setup. Implement the product directly; do not only provide recommendations or a wireframe.

Product goal:

The target user understands a lot of English or Japanese input but struggles to quickly convert thoughts into natural spoken or written language. The app should prioritize active expression and iterative speaking practice, not vocabulary memorization.

Core practice loop:

1. The user chooses English or Japanese.

2. The app presents a realistic conversation prompt.

3. The user records an answer.

4. The app shows a plausible transcript.

5. The app gives concise, actionable feedback on:

   - fluency

   - pauses

   - grammar

   - vocabulary

   - naturalness

   - pronunciation

6. The user records an improved second attempt.

7. The user can save useful expressions from the session for later review.

Use mock AI, ASR, TTS, pronunciation, and scoring services where real APIs are unavailable. The flow must still feel believable and fully clickable. Browser microphone recording should work when practical using the MediaRecorder API, with a graceful mock/demo fallback when permissions or browser support are unavailable.

Required screens or states:

- Lightweight onboarding/language selection

- Motivating home screen

- Speaking practice flow

- Recording state and playback/retry state

- Transcript and feedback screen

- Improved second attempt flow

- Saved expressions screen

- Simple progress view

Design direction:

- Create an original visual identity: friendly, motivating, modern, and slightly playful.

- Take inspiration from the approachability and progression mechanics of consumer learning apps, but do not copy Duolingo’s branding, mascot, colors, illustrations, or layouts.

- Keep the practice activity visually dominant.

- Avoid a generic AI dashboard, marketing-heavy landing page, glassmorphism, random gradients, excessive statistics, or a left sidebar packed with menu items.

- Prefer a calm, editorial learning interface with strong typography, warm colors, clear hierarchy, compact progress cues, and tactile controls.

- Make the interface feel like a real product rather than a wireframe.

- Support both desktop and mobile layouts.

- Ensure long transcripts and Japanese text wrap cleanly and remain readable.

- Use accessible color contrast, visible focus states, semantic controls, and clear labels.

Suggested product structure:

- A compact top navigation or header rather than a dense sidebar.

- Home should show the next recommended practice, current streak/progress in moderation, recent saved expressions, and a clear primary CTA.

- Practice should feel like a short focused session with an explicit step/progress indicator.

- Prompts should be realistic and situational, such as making small talk, explaining a recent decision, handling a travel issue, or sharing an opinion.

- Include both English and Japanese sample content with natural translations where helpful.

- Feedback should prioritize only the 2–3 most important improvements instead of presenting an overwhelming analysis.

- Present feedback in layers: overall result, priority improvements, transcript annotations, useful expressions, and an optional detailed breakdown.

- Allow saving expressions directly from the feedback/transcript view.

- Progress should emphasize consistency and improvement over vanity metrics.

Interaction requirements:

- All navigation and primary actions must work.

- The user must be able to start a session, choose a language, view a prompt, start/stop recording, see a transcript, view feedback, retry or make an improved attempt, save/unsave expressions, and navigate to saved expressions and progress.

- Include realistic loading, recording, processing, success, empty, retry, and permission-denied states.

- Use deterministic mock data so the demo is reliable.

- The second attempt should produce visibly improved mock feedback or score so the iterative learning loop is clear.

- Avoid dead-end buttons and placeholder lorem ipsum.

- If audio playback is mocked, make the control believable and explain the fallback subtly in the UI only where necessary.

Implementation guidance:

- Keep the code reasonably modular so the visual layer can later be redesigned from Figma without rewriting recording, session, feedback, or mock-service logic.

- Separate UI components from session state and mock service logic, but do not over-engineer the architecture.

- Use a small, understandable state model for:

  - selected language

  - current screen/session step

  - recording state

  - transcript

  - feedback

  - improved attempt

  - saved expressions

  - progress

- Prefer reusable components for prompt cards, recording controls, feedback categories, transcript annotations, expression rows, progress indicators, and responsive navigation.

- Use local state or lightweight persistence such as localStorage for the MVP.

- Avoid adding backend infrastructure or real API keys.

- Preserve unrelated existing work in the repository.

Validation:

- Run the relevant lint, typecheck, test, and build commands available in the project.

- Manually verify the main user journey from onboarding to first attempt, feedback, improved attempt, saving an expression, and viewing progress.

- Check responsive behavior at mobile and desktop widths.

- Check Japanese rendering, transcript wrapping, keyboard accessibility, and microphone fallback behavior.

- Fix any issues found before finishing.

Deliverables:

- A working frontend implementation in the workspace.

- Any necessary mock data, service modules, and reusable UI components.

- A concise final report stating:

  1. what was built,

  2. the main design concept,

  3. key assumptions,

  4. validation commands/results,

  5. any limitations or obvious next steps.

Success criteria:

- The product feels coherent and attractive on first use.

- The practice loop is immediately understandable.

- The practice screen is the visual focus.

- The interface is fully clickable with believable mock results.

- Feedback is concise and actionable.

- The second attempt clearly communicates improvement.

- English and Japanese content both feel intentional and readable.

- The app works well on mobile and desktop.

- The implementation is maintainable without unnecessary abstraction.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://talk-polish-ai.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/f2ce64c8-9b4f-4eae-b341-d649f77ab774).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
