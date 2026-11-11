# UI Comments

Figma-style comments on your running web app. Click a spot on the page, write what should change, and
Claude Code makes the change when you ask. Each comment carries the exact element, its size and styles,
and the source file, so you never have to take screenshots and describe where.

## Install (once per computer)

You need **Claude Code** (the VS Code extension or the terminal app) and **Node.js 18 or newer**.

1. Unzip so this folder ends up at:
   - Windows: `C:\Users\<your name>\.claude\skills\ui-comments`
   - Mac: `~/.claude/skills/ui-comments` (in Finder: Go > Go to Folder, type `~/.claude/skills`)

   Create the `skills` folder if it is not there. The folder must be named exactly `ui-comments`.
2. Restart Claude Code. That is all.

## Turn it on in a project (once per project)

Open Claude Code in your project and say: **"I want comment functionality in this project"**.

For a Vite project (most React and Vue projects), Claude adds a few lines to the Vite config, and the
comment toolbar then appears by itself whenever you open the project's local link, in any browser.
Builds and deployed sites never include it. Other projects get a "Comment" bookmark to click instead.

## Every day

1. Run the project as usual and open its local link in any browser. The toolbar is at the bottom.
2. Press **C** (or click **Comment**), click a spot or drag a box over an area, type your note, press **Enter**.
   - The chips above the box widen the comment to a parent (the whole tab bar instead of one tab).
   - **C** again turns comment mode off, so you can click through your app. **Esc** cancels.
   - The list button shows every comment in the project, across screens. Click one to jump to it.
   - The X shrinks the toolbar to a small corner button. **C** still works.
3. To try a change before asking for it, press **E** (or click **Edit**) and click any text, box or button.
   A panel opens with its colours, type, stroke, radius, spacing, size, opacity and words. Change anything
   and the page updates as you type.
   - Drag a label left or right, or use the arrow keys (Shift for steps of 10), as in Figma.
   - The swatch lists the project's own colours by name.
   - "Also preview on the look-alikes" applies the change to every matching element, such as all the tabs.
   - These are previews only: a reload, **Reset**, or the "previewed" pill on the toolbar puts the page back.
   - Like it? Click **Comment these changes**. The pin keeps the exact before and after values, and its
     **Preview** button shows them on the page again later.
4. In Claude Code: **"apply my comments"**. Claude makes the changes and resolves each pin with a short
   note. If something is unclear, the pin turns amber with Claude's question: answer it on the pin.

## Share it with reviewers elsewhere

Ask Claude to "host it on a tunnel". Reviewers open the public link it gives you and pin comments as usual;
the comments are stored on your computer and appear on your own local page within a few seconds, labelled
Reviewer. Only your computer can delete comments. Stop the tunnel when the review is over.

## Where things live

- This folder: the tool itself (a Claude Code skill, so every project on the computer can use it).
- `~/.claude/ui-comments/`: your comments, one folder per project. They stay on your computer and never go
  into a project or git, so each person's comments are their own.
