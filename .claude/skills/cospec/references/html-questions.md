# Asking with an HTML page

This file holds a general technique for `/cospec` (`SKILL.md` in the parent directory).
Use it when a question round does not fit the question tool.
The technique writes the questions as one HTML page in the spec directory, and the user reads that page in the web interface and sends the answers back.

## When to use it

Use the page when one of these is true:

- The round has many questions, and the question tool would need call after call.
- One question has more options than the tool holds, or the options need a picture, a color, a layout, or a long description.
- The question tool is not available at all.

Use the question tool for everything else.
A short round of two or three plain questions belongs in the tool, not on a page.

## Gates stay in chat

The page collects answers.
It never gates a stage.
Ask every gate in chat, under the rules in `SKILL.md`, whatever the user did on the page.
An answer typed in chat wins over anything the page shows.

## Handing the page over

Hand the page to the user with one question, so the round stays inside the one hard rule of `SKILL.md`.
Name the page's path in the question text.
Then stop and wait, under the waiting rule of that file.

```question
Question: I put <what is on the page, in a few words> at <path to the page>. Run `npx cospec` in your project to open it in your browser, fill it in, and use the button at the end to copy the result into a comment. Are your answers in?
Header: Questions
- I sent my answers (Recommended)
  I read them and carry on from there.
- Ask me here instead
  I drop the page, and I ask you the same things in this chat, a few at a time.
```

With no question tool, hand the page over as a normal message that ends your turn, as `SKILL.md` states, and keep the same two choices in it.
On "ask me here instead": delete the page, and ask the round as normal questions.

## Where the page lives

Write the page as a lowercase HTML file in the spec directory, beside the document its questions are about.
For example, put a round of interview questions beside `spec/SPEC.md`, as `spec/interview-round-2.html`.
The web interface renders every file in the spec directory, so the page needs nothing else to be readable.

Delete the page as soon as you fold its answers into the artifacts.
A page still on disk means a round the user has not answered yet.

## The page

Each page is one complete standalone HTML document.
Use inline styles, no external resources, and images as data URLs.
The page holds:

- One or two short lines: what the round is about, and how to send the answers back.
- One block per question: the question, its input, and a short description of each option.
- A stable id on every question, in the form `<a short kebab-case name>`. The id goes into the answer text, so keep it short and readable.
- The copy control and the answer box, at the end.

Give each question the input that fits it: radio buttons for one choice, checkboxes for several, and a text box for free text.
Give the user a way to say what the options do not cover: a text box on the question itself, or one question at the end of the page for anything else.

## The answers

The copy control writes the answers as plain text into the answer box, and copies that text to the clipboard.
The user pastes the text into a web-interface comment, or into chat.
A comment arrives as a `.cospec/user-feedback.json` file, which the "The web interface" section of `references/stages.md` tells you how to apply.

The text follows this format, unless the file that asks for the page defines an output of its own:

```
cospec-answers: <the page's file name, without the extension>
- <question id>: <the answer>
- <question id>: <the answer>; <the second answer>
- <question id>: (no answer)
```

The format is what lets you match each answer back to its question:

- One line per question, in the order the page shows them.
- Several answers to one question join with `; `.
- A question the user left alone reads `(no answer)`.
- A free-text answer goes on one line, in the user's own words. Replace a line break the user typed with a space, and read a `; ` inside a free-text answer as part of the text.

**The manual-copy fallback.**
The clipboard can be blocked in the frame the web interface renders the page in.
For this reason the answer box is always visible, and it always holds the same text the control copies.
The user can select the text there and copy it by hand.
Say this on the page, in one line beside the control.

## Themes

The web interface pushes the reader's theme into the page: it sets `data-theme` on the root element, to `light` or `dark`.
Style both `[data-theme="dark"]` and `[data-theme="light"]`, and fall back to `prefers-color-scheme` when no `data-theme` is set.
The page then reads well in the web interface and in a plain browser tab.
Give the page no theme toggle of its own.

## Example

This example shows the skeleton, both theme mechanisms, and the exact answer format.
Take the shape from it, and write the real page for the real questions.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Interview round 2</title>
    <style>
      :root { color-scheme: light dark; --bg: #ffffff; --fg: #1a1a1a; --line: #d8d8d8; }
      @media (prefers-color-scheme: dark) {
        :root { --bg: #16181c; --fg: #e8e8e8; --line: #33373d; }
      }
      :root[data-theme="light"] { color-scheme: light; --bg: #ffffff; --fg: #1a1a1a; --line: #d8d8d8; }
      :root[data-theme="dark"] { color-scheme: dark; --bg: #16181c; --fg: #e8e8e8; --line: #33373d; }
      body { background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 44rem; padding: 2rem 1.25rem; }
      fieldset { border: 1px solid var(--line); border-radius: 8px; margin: 0 0 1.25rem; padding: 1rem; }
      .hint { color: var(--fg); opacity: 0.75; font-size: 0.9rem; }
      textarea { background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 8px; width: 100%; min-height: 8rem; padding: 0.75rem; }
    </style>
  </head>
  <body>
    <h1>Interview round 2</h1>
    <p class="hint">These questions are about the screens for the checkout work.</p>
    <p class="hint">Answer what you can, then copy the text at the end and paste it into a comment here, or into the chat.</p>

    <form id="answers">
      <fieldset data-question="theme">
        <legend>Which themes should the screens support?</legend>
        <label><input type="radio" name="theme" value="Both light and dark" /> Both light and dark</label>
        <p class="hint">Every screen is drawn twice, and it follows the theme of the browser.</p>
        <label><input type="radio" name="theme" value="Light only" /> Light only</label>
        <label>Something else: <input type="text" name="theme-other" size="30" /></label>
      </fieldset>

      <fieldset data-question="devices">
        <legend>Which devices matter? Pick as many as apply.</legend>
        <label><input type="checkbox" name="devices" value="Desktop" /> Desktop</label>
        <p class="hint">A wide window, with room for a side panel.</p>
        <label><input type="checkbox" name="devices" value="Phone" /> Phone</label>
      </fieldset>

      <fieldset data-question="anything-else">
        <legend>Anything else I should know?</legend>
        <input type="text" name="anything-else" size="60" />
      </fieldset>
    </form>

    <button type="button" id="copy">Copy my answers</button>
    <p class="hint">If the copy button does nothing, select the text below and copy it by hand.</p>
    <textarea id="out" readonly></textarea>

    <script>
      const page = 'interview-round-2';
      const form = document.getElementById('answers');
      const out = document.getElementById('out');

      function build() {
        const lines = ['cospec-answers: ' + page];
        for (const block of form.querySelectorAll('[data-question]')) {
          const id = block.dataset.question;
          const picked = [...block.querySelectorAll('input')]
            .filter((input) => (input.type === 'text' ? input.value.trim() : input.checked))
            .map((input) => (input.type === 'text' ? input.value.trim() : input.value));
          lines.push('- ' + id + ': ' + (picked.length ? picked.join('; ') : '(no answer)'));
        }
        out.value = lines.join('\n');
      }

      form.addEventListener('input', build);
      document.getElementById('copy').addEventListener('click', () => {
        build();
        navigator.clipboard?.writeText(out.value).catch(() => {});
        out.select();
      });
      build();
    </script>
  </body>
</html>
```
